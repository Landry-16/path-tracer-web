import { cameraBasis, frame } from "../core/camera";
import { Emitter } from "../core/emitter";
import { objectBounds, raycast } from "../core/geometry";
import { add, length, scale, sub, type Vec3 } from "../core/math";
import { MATERIAL_PRESETS, SCENE_PRESETS, materialFromPreset, scenePreset } from "../core/presets";
import {
  LIGHT_TYPES,
  SHAPES,
  TONE_MAPPINGS,
  cloneScene,
  createLight,
  createObject,
  findItem,
  findMaterial,
  normalizeScene,
  uid,
  type Light,
  type LightType,
  type Material,
  type Scene,
  type SceneObject,
  type ShapeType,
} from "../core/scene";
import { encodeScene } from "../core/share";
import { renderMaterialPreview } from "../preview/preview";
import { Viewer } from "../viewer/viewer";
import {
  colorField,
  h,
  icon,
  iconButton,
  numberField,
  section,
  selectField,
  textField,
  toggleField,
  vec3Field,
  type Field,
  type FieldHooks,
} from "./dom";
import { Gizmo, type GizmoMode } from "./gizmo";
import { History } from "./history";
import css from "./editor.css?inline";

export interface EditorOptions {
  /** Initial scene. Anything JSON-like is accepted and normalized. Defaults to the "studio" preset. */
  scene?: Scene | object;
  /** When set, the scene is saved to localStorage under this key and restored on the next visit. */
  storageKey?: string | null;
  /** Base URL of a deployed copy of this project, used to build share and embed links. Defaults to DEFAULT_BASE_URL. */
  baseUrl?: string;
  /** Light follows the pointer from the start. Default false. */
  lightFollow?: boolean;
  /** Show the left (scene, materials) and right (inspector) panels. Default true on wide screens. */
  panels?: boolean;
}

export type EditorEvents = {
  /** A finished edit (one undo step). */
  change: { scene: Scene };
  /** Live edits while dragging or typing. */
  input: { scene: Scene };
  select: { id: string | null; kind: "object" | "light" | "material" | null };
};

type Selection = { type: "item"; id: string } | { type: "material"; id: string } | null;

/** Public deployment used for share and embed links when no baseUrl is given. */
export const DEFAULT_BASE_URL = "https://landry-16.github.io/path-tracer-web/";

const SHAPE_LABELS: Record<ShapeType, string> = { sphere: "Sphere", box: "Box", cylinder: "Cylinder", cone: "Cone", plane: "Plane", disk: "Disk" };
const LIGHT_LABELS: Record<LightType, string> = { area: "Area light", sphere: "Sphere light", point: "Point light", sun: "Sun" };
const LIGHT_ICONS: Record<LightType, string> = { area: "area", sphere: "light-sphere", point: "point", sun: "sun" };

/** Snapshot used by undo: everything except the orbit position of the camera. */
function snapshot(scene: Scene): string {
  const { fov, aperture, focusDistance } = scene.camera;
  return JSON.stringify({ ...scene, camera: { fov, aperture, focusDistance } });
}

function materialKey(m: Material): string {
  return JSON.stringify({ ...m, id: "", name: "" });
}

/**
 * Full scene editor: toolbar, outliner, material library, inspector and an
 * interactive path traced viewport with gizmos. It renders into a shadow root
 * so it can be dropped into any page without style conflicts.
 */
export class Editor extends Emitter<EditorEvents> {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly viewer: Viewer;
  readonly gizmo: Gizmo;

  private readonly options: EditorOptions;
  private readonly history: History;
  private selection: Selection = null;
  private fields: Field[] = [];
  private readonly ui: {
    shell: HTMLElement;
    tree: HTMLElement;
    swatches: HTMLElement;
    inspector: HTMLElement;
    viewport: HTMLElement;
    samples: HTMLElement;
    speed: HTMLElement;
    resolution: HTMLElement;
    progress: HTMLElement;
    pause: HTMLButtonElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    follow: HTMLButtonElement;
    modes: Record<GizmoMode, HTMLButtonElement>;
    toast: HTMLElement;
    error: HTMLElement;
  };
  private readonly swatchCache = new Map<string, { el: HTMLElement; canvas: HTMLCanvasElement; key: string }>();
  private inspectorPreview: { canvas: HTMLCanvasElement; materialId: string; key: string } | null = null;
  private menu: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private overlayHandle = 0;
  private saveTimer = 0;
  private followCommitTimer = 0;
  private previewTimer = 0;
  private toastTimer = 0;
  private disposed = false;

  constructor(container: HTMLElement, options: EditorOptions = {}) {
    super();
    this.options = options;
    this.host = h("div", { class: "pt-editor-host" });
    this.host.style.cssText = "display:block;width:100%;height:100%";
    container.appendChild(this.host);
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.append(h("style", {}, css));

    let initial: Scene | null = null;
    if (options.storageKey) initial = this.loadStored(options.storageKey);
    const scene = initial ?? (options.scene ? normalizeScene(options.scene) : scenePreset("studio"));

    const viewHost = h("div", { class: "pt-view" });
    const toast = h("div", { class: "pt-toast", role: "status", "aria-live": "polite" });
    const error = h("div", { class: "pt-error", hidden: true });
    const samples = h("b", {}, "0");
    const speed = h("b", {}, "0");
    const resolution = h("b", {}, "0 x 0");
    const progress = h("div", { class: "pt-progress" });
    const pause = iconButton("pause", "Pause rendering (Space)", () => this.togglePause());
    const status = h(
      "div",
      { class: "pt-status" },
      h("span", { class: "pt-stat" }, h("i", {}, "Samples"), samples),
      h("span", { class: "pt-stat" }, h("i", {}, "Speed"), speed, h("i", {}, "spp/s")),
      h("span", { class: "pt-stat" }, h("i", {}, "Size"), resolution),
      h("span", { class: "pt-hint" }, "Click to select, drag to orbit, right drag to pan, scroll to zoom"),
      pause,
      iconButton("camera", "Save image (PNG)", () => void this.capture()),
      progress,
    );
    const viewport = h("main", { class: "pt-viewport" }, viewHost, status, toast, error);

    this.viewer = new Viewer(viewHost, { scene, lightFollow: options.lightFollow ?? false });
    this.viewer.lightFollowTarget = (s) => {
      const sel = this.selection?.type === "item" ? findItem(s, this.selection.id) : null;
      if (sel?.kind === "light" && sel.item.type !== "sun") return sel.item;
      return s.lights.find((l) => l.enabled && l.type !== "sun") ?? null;
    };
    this.gizmo = new Gizmo(this.viewer, {
      selectedId: () => (this.selection?.type === "item" ? this.selection.id : null),
      select: (id) => this.select(id),
      changed: () => this.changed(),
      commit: () => this.commit(),
    });
    this.viewer.addTool(this.gizmo);
    this.history = new History(snapshot(this.viewer.scene));

    const undo = iconButton("undo", "Undo (Ctrl+Z)", () => this.undo());
    const redo = iconButton("redo", "Redo (Ctrl+Shift+Z)", () => this.redo());
    const follow = iconButton("follow", "Light follows the pointer (L)", () => this.setLightFollow(!this.viewer.lightFollow));
    const modes = {
      translate: iconButton("move", "Move (W)", () => this.setMode("translate")),
      rotate: iconButton("rotate", "Rotate (E)", () => this.setMode("rotate")),
      scale: iconButton("scale", "Scale (R)", () => this.setMode("scale")),
    };

    const addButton = h("button", { type: "button", class: "pt-btn pt-primary pt-label-btn", title: "Add an object, a light or a material" }, icon("plus"), h("span", {}, "Add"));
    addButton.addEventListener("click", (e) => this.openAddMenu(e.currentTarget as HTMLElement));
    const sceneButton = h("button", { type: "button", class: "pt-btn pt-label-btn", title: "Load a preset scene" }, icon("scene"), h("span", {}, "Scenes"));
    sceneButton.addEventListener("click", (e) => this.openSceneMenu(e.currentTarget as HTMLElement));

    const toolbar = h(
      "header",
      { class: "pt-toolbar" },
      iconButton("panel", "Toggle scene panel", () => this.togglePanel("left")),
      h("div", { class: "pt-brand" }, h("span", { class: "pt-brand-mark" }), h("span", { class: "pt-brand-text" }, "Path Tracer")),
      addButton,
      h("span", { class: "pt-sep" }),
      h("div", { class: "pt-group", role: "group", "aria-label": "Gizmo mode" }, modes.translate, modes.rotate, modes.scale),
      follow,
      h("span", { class: "pt-sep" }),
      undo,
      redo,
      h("span", { class: "pt-spacer" }),
      sceneButton,
      iconButton("upload", "Import a scene (JSON)", () => this.importFile()),
      iconButton("download", "Export the scene (JSON)", () => this.exportFile()),
      iconButton("share", "Copy a share link", () => void this.share()),
      iconButton("code", "Embed this scene in another site", () => void this.openEmbed()),
      h("span", { class: "pt-sep" }),
      iconButton("panel-right", "Toggle inspector", () => this.togglePanel("right")),
    );

    const tree = h("div", { class: "pt-scroll", role: "tree", "aria-label": "Scene" });
    const swatches = h("div", { class: "pt-swatches" });
    const left = h(
      "aside",
      { class: "pt-left" },
      h(
        "section",
        { class: "pt-panel pt-outliner" },
        h("div", { class: "pt-panel-head" }, h("span", {}, "Scene"), iconButton("plus", "Add", (e) => this.openAddMenu(e.currentTarget as HTMLElement))),
        tree,
      ),
      h(
        "section",
        { class: "pt-panel pt-library" },
        h(
          "div",
          { class: "pt-panel-head" },
          h("span", {}, "Materials"),
          iconButton("trash", "Remove unused materials", () => this.removeUnusedMaterials()),
          iconButton("plus", "New material", (e) => this.openMaterialMenu(e.currentTarget as HTMLElement)),
        ),
        h("div", { class: "pt-scroll" }, swatches),
      ),
    );
    const inspector = h("div", { class: "pt-inspector" });
    const right = h("aside", { class: "pt-right", "aria-label": "Inspector" }, inspector);
    const shell = h("div", { class: "pt-editor", tabindex: "-1" }, toolbar, h("div", { class: "pt-body" }, left, viewport, right));
    this.root.append(shell);

    this.ui = { shell, tree, swatches, inspector, viewport, samples, speed, resolution, progress, pause, undo, redo, follow, modes, toast, error };

    const narrow = container.clientWidth > 0 && container.clientWidth < 860;
    if (options.panels === false || narrow) shell.classList.add("pt-no-left", "pt-no-right");

    this.bindEvents();
    this.setMode("translate");
    this.setLightFollow(this.viewer.lightFollow);
    this.rebuild();
    this.overlayHandle = requestAnimationFrame(this.drawOverlay);
  }

  /* ================================================================ API */

  /** The live scene. Mutate it and call `refresh()` (or let the next frame pick it up). */
  get scene(): Scene {
    return this.viewer.scene;
  }

  /** A deep copy of the scene, safe to store or send. */
  getScene(): Scene {
    return cloneScene(this.viewer.scene);
  }

  toJSON(): Scene {
    return this.getScene();
  }

  /** Loads a new scene and clears the undo history. */
  setScene(scene: Scene | object): void {
    this.viewer.setScene(scene);
    this.selection = null;
    this.history.reset(snapshot(this.viewer.scene));
    this.rebuild();
    this.save();
    this.emit("change", { scene: this.viewer.scene });
  }

  /** Id of the selected object or light. */
  get selectedId(): string | null {
    return this.selection?.type === "item" ? this.selection.id : null;
  }

  select(id: string | null): void {
    const material = id ? this.scene.materials.find((m) => m.id === id) : null;
    const item = findItem(this.scene, id);
    this.selection = material ? { type: "material", id: material.id } : item ? { type: "item", id: item.item.id } : null;
    this.renderTree();
    this.renderSwatches();
    this.renderInspector();
    this.emit("select", { id: this.selection?.id ?? null, kind: material ? "material" : item ? item.kind : null });
  }

  addObject(shape: ShapeType, partial: Partial<SceneObject> = {}): SceneObject {
    const material = partial.materialId ? null : materialFromPreset("plastic", { name: `${SHAPE_LABELS[shape]} material`, baseColor: "#d4d4d4" });
    if (material) this.scene.materials.push(material);
    const flat = shape === "plane" || shape === "disk";
    const size = flat ? 1.5 : 0.6;
    const object = createObject(shape, {
      name: this.uniqueName(SHAPE_LABELS[shape], this.scene.objects),
      scale: flat ? [size, 1, size] : [size, size, size],
      materialId: material?.id,
      position: this.dropPoint(flat ? 0.001 : size / 2),
      ...partial,
    });
    this.scene.objects.push(object);
    this.commit();
    this.select(object.id);
    return object;
  }

  addLight(type: LightType, partial: Partial<Light> = {}): Light {
    const light = createLight(type, { name: this.uniqueName(LIGHT_LABELS[type], this.scene.lights), position: this.lightPoint(type), ...partial });
    this.scene.lights.push(light);
    this.commit();
    this.select(light.id);
    return light;
  }

  addMaterial(partial: Partial<Material> = {}, presetId = "plastic"): Material {
    const material = materialFromPreset(presetId, partial);
    material.name = this.uniqueName(material.name, this.scene.materials);
    this.scene.materials.push(material);
    const target = this.selection?.type === "item" ? findItem(this.scene, this.selection.id) : null;
    if (target?.kind === "object") {
      target.item.materialId = material.id;
      this.commit();
      this.renderInspector();
    } else {
      this.commit();
      this.select(material.id);
    }
    return material;
  }

  /** Removes an object, a light or a material (objects using it fall back to another material). */
  remove(id: string): void {
    const scene = this.scene;
    const m = scene.materials.findIndex((x) => x.id === id);
    if (m >= 0) {
      if (scene.materials.length <= 1) {
        this.toast("A scene needs at least one material");
        return;
      }
      scene.materials.splice(m, 1);
      const fallback = scene.materials[0].id;
      for (const o of scene.objects) if (o.materialId === id) o.materialId = fallback;
    } else {
      scene.objects = scene.objects.filter((o) => o.id !== id);
      scene.lights = scene.lights.filter((l) => l.id !== id);
    }
    if (this.selection?.id === id) this.selection = null;
    this.commit();
    this.rebuild();
  }

  /** Duplicates an object or light, slightly offset, and selects the copy. */
  duplicate(id: string): string | null {
    const found = findItem(this.scene, id);
    if (!found) return null;
    const offset: Vec3 = [0.25, 0, 0.25];
    if (found.kind === "object") {
      const copy: SceneObject = { ...structuredClone(found.item), id: uid("obj"), name: this.uniqueName(found.item.name, this.scene.objects) };
      copy.position = add(copy.position, offset);
      this.scene.objects.push(copy);
      this.commit();
      this.select(copy.id);
      return copy.id;
    }
    const copy: Light = { ...structuredClone(found.item), id: uid("light"), name: this.uniqueName(found.item.name, this.scene.lights) };
    copy.position = add(copy.position, offset);
    this.scene.lights.push(copy);
    this.commit();
    this.select(copy.id);
    return copy.id;
  }

  undo(): void {
    const state = this.history.undo();
    if (state) this.restore(state);
  }

  redo(): void {
    const state = this.history.redo();
    if (state) this.restore(state);
  }

  setMode(mode: GizmoMode): void {
    this.gizmo.mode = mode;
    for (const [key, button] of Object.entries(this.ui.modes)) button.classList.toggle("pt-active", key === mode);
  }

  setLightFollow(on: boolean): void {
    this.viewer.lightFollow = on;
    this.ui.follow.classList.toggle("pt-active", on);
    this.ui.follow.setAttribute("aria-pressed", String(on));
  }

  /** Re-reads the scene after outside code mutated it. */
  refresh(): void {
    this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.overlayHandle);
    this.viewer.dispose();
    this.host.remove();
  }

  /* ========================================================= state flow */

  /** Live edit: re-sync the inspector and previews, without an undo step. */
  private changed(): void {
    this.fields.forEach((f) => f.refresh());
    this.schedulePreviews();
    this.emit("input", { scene: this.scene });
  }

  /** Finished edit: record an undo step, save, refresh the panels. */
  private commit(): void {
    if (this.history.push(snapshot(this.scene))) {
      this.emit("change", { scene: this.scene });
    }
    this.updateUndoButtons();
    this.renderTree();
    this.renderSwatches();
    this.fields.forEach((f) => f.refresh());
    this.schedulePreviews();
    this.scheduleSave();
  }

  private restore(state: string): void {
    const camera = this.scene.camera;
    const next = normalizeScene(JSON.parse(state));
    next.camera = { ...camera, ...next.camera, target: camera.target, yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance };
    this.viewer.setScene(next, { keepHome: true });
    if (this.selection && !findItem(next, this.selection.id) && !next.materials.some((m) => m.id === this.selection?.id)) this.selection = null;
    this.rebuild();
    this.scheduleSave();
    this.emit("change", { scene: this.scene });
  }

  private rebuild(): void {
    this.updateUndoButtons();
    this.renderTree();
    this.renderSwatches();
    this.renderInspector();
  }

  private updateUndoButtons(): void {
    this.ui.undo.disabled = !this.history.canUndo;
    this.ui.redo.disabled = !this.history.canRedo;
  }

  private hooks(): FieldHooks {
    return { onInput: () => this.changed(), onCommit: () => this.commit() };
  }

  /* ======================================================== persistence */

  private loadStored(key: string): Scene | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? normalizeScene(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    const key = this.options.storageKey;
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(this.scene));
    } catch {
      // Storage full or blocked (private mode): the editor keeps working without it.
    }
  }

  private scheduleSave(): void {
    if (!this.options.storageKey) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 400);
  }

  /* ============================================================= events */

  private bindEvents(): void {
    const viewer = this.viewer;
    viewer.on("frame", (f) => {
      this.ui.samples.textContent = f.converged ? `${f.samples} done` : String(f.samples);
      this.ui.speed.textContent = String(f.samplesPerSecond);
      this.ui.resolution.textContent = `${f.width} x ${f.height}`;
      const max = this.scene.render.maxSamples;
      this.ui.progress.style.width = max > 0 ? `${Math.min(100, (f.samples / max) * 100)}%` : "0";
    });
    viewer.on("error", ({ message }) => {
      this.ui.error.textContent = message;
      this.ui.error.hidden = false;
    });
    viewer.on("change", ({ source }) => {
      if (source === "light") {
        this.changed();
        clearTimeout(this.followCommitTimer);
        this.followCommitTimer = window.setTimeout(() => this.commit(), 500);
      } else {
        this.scheduleSave();
      }
    });
    viewer.on("tap", (e) => {
      if (e.altKey) {
        // Alt + click focuses the depth of field on the clicked surface.
        const hit = raycast(this.scene, viewer.rayAt(e.clientX, e.clientY), { lights: false });
        if (hit) {
          const b = cameraBasis(this.scene.camera);
          this.scene.camera.focusDistance = Math.max(0.01, length(sub(hit.point, b.position)));
          if (this.scene.camera.aperture === 0) this.scene.camera.aperture = 0.03;
          this.commit();
          this.toast(`Focus at ${this.scene.camera.focusDistance.toFixed(2)}`);
        }
        return;
      }
      this.gizmo.tap(e.clientX, e.clientY);
    });
    viewer.canvas.addEventListener("dblclick", () => {
      if (this.selectedId) this.frameSelection();
    });

    this.ui.shell.addEventListener("keydown", this.onKeyDown);
    this.root.addEventListener("pointerdown", (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
    });

    // Drop a JSON file anywhere to import it, or a material swatch on an object to assign it.
    const viewport = this.ui.viewport;
    this.ui.shell.addEventListener("dragover", (e) => {
      const types = e.dataTransfer?.types ?? [];
      if (types.includes("Files") || types.includes("application/x-pt-material")) {
        e.preventDefault();
        viewport.classList.toggle("pt-drop-target", types.includes("application/x-pt-material") && !!this.gizmo.objectAt(e.clientX, e.clientY));
      }
    });
    this.ui.shell.addEventListener("dragleave", () => viewport.classList.remove("pt-drop-target"));
    this.ui.shell.addEventListener("drop", (e) => {
      viewport.classList.remove("pt-drop-target");
      const materialId = e.dataTransfer?.getData("application/x-pt-material");
      if (materialId) {
        e.preventDefault();
        const objectId = this.gizmo.objectAt(e.clientX, e.clientY);
        const object = this.scene.objects.find((o) => o.id === objectId);
        if (object) {
          object.materialId = materialId;
          this.commit();
          this.select(object.id);
        }
        return;
      }
      const file = e.dataTransfer?.files[0];
      if (file) {
        e.preventDefault();
        void this.readFile(file);
      }
    });
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const target = e.composedPath()[0] as HTMLElement;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && key === "d") {
      e.preventDefault();
      if (this.selectedId) this.duplicate(this.selectedId);
      return;
    }
    if (mod && key === "s") {
      e.preventDefault();
      this.exportFile();
      return;
    }
    if (mod || e.altKey) return;
    switch (key) {
      case "w": this.setMode("translate"); break;
      case "e": this.setMode("rotate"); break;
      case "r": this.setMode("scale"); break;
      case "l": this.setLightFollow(!this.viewer.lightFollow); break;
      case "f": this.frameSelection(); break;
      case "h": this.gizmo.hidden = !this.gizmo.hidden; break;
      case " ": this.togglePause(); break;
      case "?": this.openShortcuts(); break;
      case "escape":
        if (this.modal) this.closeModal();
        else if (this.menu) this.closeMenu();
        else this.select(null);
        break;
      case "delete":
      case "backspace":
        if (this.selection) this.remove(this.selection.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  /* ========================================================= operations */

  private uniqueName(base: string, list: { name: string }[]): string {
    const names = new Set(list.map((x) => x.name));
    const stem = base.replace(/ \d+$/, "");
    if (!names.has(stem)) return stem;
    for (let i = 2; ; i++) if (!names.has(`${stem} ${i}`)) return `${stem} ${i}`;
  }

  /** Where a new object lands: on the surface at the center of the view. */
  private dropPoint(height: number): Vec3 {
    const ray = this.viewer.rayAt(...this.viewportCenter());
    const hit = raycast(this.scene, ray, { lights: false });
    if (hit && hit.normal[1] > 0.5) return add(hit.point, [0, height, 0]);
    const t = this.scene.camera.target;
    return [t[0], Math.max(height, 0), t[2]];
  }

  /** Lights go under the ceiling above the view center when there is one, otherwise above it. */
  private lightPoint(type: LightType): Vec3 {
    const t = this.scene.camera.target;
    const up = raycast(this.scene, { origin: t, direction: [0, 1, 0] }, { lights: false });
    if (type === "sun") return add(t, [0, 2, 0]);
    if (up && up.t < 6) return add(t, [0, up.t - (type === "area" ? 0.002 : 0.3), 0]);
    return add(t, [0, 1.6, 0]);
  }

  private viewportCenter(): [number, number] {
    const r = this.viewer.canvas.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  private frameSelection(): void {
    const item = this.selectedId ? findItem(this.scene, this.selectedId) : null;
    if (!item) {
      this.viewer.resetCamera();
      return;
    }
    if (item.kind === "object") {
      const b = objectBounds(item.item);
      const center = scale(add(b.min, b.max), 0.5);
      frame(this.scene.camera, center, Math.max(0.1, length(sub(b.max, b.min)) / 2));
    } else {
      frame(this.scene.camera, item.item.position, item.item.type === "area" ? Math.max(...item.item.size) : 0.5);
    }
    this.scheduleSave();
  }

  private removeUnusedMaterials(): void {
    const used = new Set(this.scene.objects.map((o) => o.materialId));
    const before = this.scene.materials.length;
    this.scene.materials = this.scene.materials.filter((m) => used.has(m.id));
    if (this.scene.materials.length === 0) this.scene.materials = [materialFromPreset("plastic", { name: "Default" })];
    const removed = before - this.scene.materials.length;
    if (this.selection?.type === "material" && !this.scene.materials.some((m) => m.id === this.selection?.id)) this.selection = null;
    this.commit();
    this.rebuild();
    this.toast(removed > 0 ? `Removed ${removed} unused material${removed > 1 ? "s" : ""}` : "Every material is in use");
  }

  private togglePause(): void {
    this.viewer.paused = !this.viewer.paused;
    this.ui.pause.replaceChildren(icon(this.viewer.paused ? "play" : "pause"));
    this.ui.pause.title = this.viewer.paused ? "Resume rendering (Space)" : "Pause rendering (Space)";
  }

  private togglePanel(side: "left" | "right"): void {
    this.ui.shell.classList.toggle(side === "left" ? "pt-no-left" : "pt-no-right");
  }

  private toast(message: string): void {
    const el = this.ui.toast;
    el.textContent = message;
    el.classList.add("pt-show");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove("pt-show"), 1800);
  }

  /* ======================================================== file / share */

  private download(name: string, blob: Blob): void {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  private fileName(ext: string): string {
    const base = this.scene.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";
    return `${base}.${ext}`;
  }

  private async capture(): Promise<void> {
    const hidden = this.gizmo.hidden;
    const blob = await this.viewer.toBlob();
    this.gizmo.hidden = hidden;
    this.download(this.fileName("png").replace(".png", `-${this.viewer.samples}spp.png`), blob);
  }

  private exportFile(): void {
    this.download(this.fileName("json"), new Blob([JSON.stringify(this.scene, null, 2)], { type: "application/json" }));
  }

  private importFile(): void {
    const input = h("input", { type: "file", accept: "application/json,.json" });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.readFile(file);
    });
    input.click();
  }

  private async readFile(file: File): Promise<void> {
    try {
      const scene = normalizeScene(JSON.parse(await file.text()));
      this.setScene(scene);
      this.toast(`Loaded ${scene.name}`);
    } catch {
      this.toast("This file is not a valid scene");
    }
  }

  private baseUrl(): string {
    const base = this.options.baseUrl ?? DEFAULT_BASE_URL;
    return base.endsWith("/") ? base : `${base}/`;
  }

  private async shareUrl(page = ""): Promise<string> {
    return `${this.baseUrl()}${page}#s=${await encodeScene(this.scene)}`;
  }

  private async copy(text: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(message);
    } catch {
      this.toast("Copy failed: select the text and copy it manually");
    }
  }

  private async share(): Promise<void> {
    await this.copy(await this.shareUrl(), "Share link copied");
  }

  private async openEmbed(): Promise<void> {
    const base = this.baseUrl();
    const viewerUrl = await this.shareUrl("viewer.html");
    const iframe = `<iframe src="${viewerUrl}"\n  style="width: 100%; aspect-ratio: 16 / 10; border: 0"\n  title="${this.scene.name}" loading="lazy" allow="fullscreen"></iframe>`;
    const json = JSON.stringify(this.scene);
    const component = `<script type="module" src="${base}lib/path-tracer.js"></script>\n\n<pt-viewer light-follow style="height: 420px">\n  <script type="application/json">${json}</script>\n</pt-viewer>`;
    const npm = `import { Viewer } from "path-tracer-web";\nimport scene from "./scene.json";\n\nconst viewer = new Viewer(document.querySelector("#view"), { scene });`;
    const block = (title: string, code: string, label: string): HTMLElement => {
      const area = h("textarea", { class: "pt-code", readonly: true, spellcheck: "false" }, code);
      return h(
        "div",
        { class: "pt-code-block" },
        h("div", { class: "pt-code-head" }, h("span", {}, title), h("button", { type: "button", class: "pt-btn", onclick: () => void this.copy(code, `${label} copied`) }, icon("copy"), "Copy")),
        area,
      );
    };
    this.openModal(
      "Embed this scene",
      h("p", {}, "Paste one of these snippets into another site. The iframe needs nothing else; the web component loads the library from this deployment and keeps the page's own styles untouched."),
      block("Iframe", iframe, "Iframe code"),
      block("Web component", component, "Web component code"),
      block("JavaScript module", npm, "Code"),
      h("div", { class: "pt-actions" }, h("button", { type: "button", class: "pt-btn", onclick: () => this.exportFile() }, icon("download"), "Download scene.json")),
    );
  }

  private openShortcuts(): void {
    const keys: [string, string][] = [
      ["Click", "Select an object or a light"],
      ["Drag", "Orbit (drag the selection to move it)"],
      ["Right drag / Shift drag", "Pan"],
      ["Wheel", "Zoom"],
      ["Double click", "Frame the selection"],
      ["Alt + click", "Focus the depth of field on a surface"],
      ["W / E / R", "Move, rotate, scale gizmo"],
      ["Ctrl while dragging", "Snap"],
      ["L", "Light follows the pointer"],
      ["F", "Frame the selection (or reset the view)"],
      ["H", "Hide the overlay"],
      ["Delete", "Remove the selection"],
      ["Ctrl + D", "Duplicate"],
      ["Ctrl + Z / Ctrl + Shift + Z", "Undo / redo"],
      ["Ctrl + S", "Export the scene"],
      ["Space", "Pause rendering"],
    ];
    this.openModal("Shortcuts", h("dl", { class: "pt-shortcuts" }, ...keys.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
  }

  private openModal(title: string, ...content: HTMLElement[]): void {
    this.closeModal();
    const backdrop = h(
      "div",
      { class: "pt-modal-backdrop" },
      h(
        "div",
        { class: "pt-modal", role: "dialog", "aria-modal": "true", "aria-label": title },
        h("div", { class: "pt-modal-head" }, h("h2", {}, title), iconButton("close", "Close", () => this.closeModal())),
        h("div", { class: "pt-modal-body" }, ...content),
      ),
    );
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) this.closeModal();
    });
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeModal();
    });
    this.ui.shell.append(backdrop);
    this.modal = backdrop;
    (backdrop.querySelector(".pt-modal .pt-icon-btn") as HTMLElement | null)?.focus();
  }

  private closeModal(): void {
    this.modal?.remove();
    this.modal = null;
    this.ui.shell.focus({ preventScroll: true });
  }

  /* ============================================================== menus */

  private openMenu(anchor: HTMLElement, ...items: (HTMLElement | null)[]): void {
    const wasOpen = this.menu?.dataset.anchor === anchor.dataset.menuId && !!anchor.dataset.menuId;
    this.closeMenu();
    if (wasOpen) return;
    anchor.dataset.menuId ||= uid("menu");
    const menu = h("div", { class: "pt-menu", role: "menu" }, ...items);
    menu.dataset.anchor = anchor.dataset.menuId;
    const shellRect = this.ui.shell.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom - shellRect.top + 4}px`;
    this.ui.shell.append(menu);
    const left = Math.min(r.left - shellRect.left, shellRect.width - menu.offsetWidth - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    this.menu = menu;
    (menu.querySelector(".pt-menu-item") as HTMLElement | null)?.focus();
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private menuItem(iconName: string, label: string, action: () => void, shortcut?: string): HTMLElement {
    const button = h("button", { type: "button", class: "pt-menu-item", role: "menuitem" }, icon(iconName), h("span", {}, label), shortcut ? h("kbd", {}, shortcut) : null);
    button.addEventListener("click", () => {
      this.closeMenu();
      action();
    });
    return button;
  }

  private openAddMenu(anchor: HTMLElement): void {
    this.openMenu(
      anchor,
      h("div", { class: "pt-menu-title" }, "Primitives"),
      ...SHAPES.map((s) => this.menuItem(s, SHAPE_LABELS[s], () => this.addObject(s))),
      h("hr"),
      h("div", { class: "pt-menu-title" }, "Lights"),
      ...LIGHT_TYPES.map((t) => this.menuItem(LIGHT_ICONS[t], LIGHT_LABELS[t], () => this.addLight(t))),
      h("hr"),
      this.menuItem("material", "Material", () => this.addMaterial()),
    );
  }

  private openMaterialMenu(anchor: HTMLElement): void {
    this.openMenu(
      anchor,
      h("div", { class: "pt-menu-title" }, "New material from"),
      ...MATERIAL_PRESETS.map((p) => this.menuItem("material", p.label, () => this.addMaterial({}, p.id))),
    );
  }

  private openSceneMenu(anchor: HTMLElement): void {
    this.openMenu(
      anchor,
      h("div", { class: "pt-menu-title" }, "Load a scene"),
      ...SCENE_PRESETS.map((p) => this.menuItem("scene", p.label, () => this.setScene(scenePreset(p.id)))),
      h("hr"),
      this.menuItem("code", "Keyboard shortcuts", () => this.openShortcuts(), "?"),
      this.menuItem("share", "Embedding guide", () => window.open(`${this.baseUrl()}embed.html`, "_blank", "noopener")),
    );
  }

  /* =========================================================== outliner */

  private renderTree(): void {
    const tree = this.ui.tree;
    const selectedId = this.selection?.id;
    const rowFor = (id: string, iconName: string, name: string, on: boolean, toggle: () => void, toggleLabel: string): HTMLElement => {
      const label = h("span", { class: "pt-tree-name" }, name);
      const eye = iconButton(on ? "eye" : "eye-off", toggleLabel, (e) => {
        e.stopPropagation();
        toggle();
        this.commit();
      }, on ? "" : "pt-off");
      const trash = iconButton("trash", "Remove", (e) => {
        e.stopPropagation();
        this.remove(id);
      });
      const row = h("div", { class: `pt-tree-row${id === selectedId ? " pt-selected" : ""}${on ? "" : " pt-dim"}`, role: "treeitem", tabindex: "0", "aria-selected": String(id === selectedId) }, icon(iconName), label, eye, trash);
      row.addEventListener("click", () => this.select(id));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.select(id);
      });
      row.addEventListener("dblclick", () => this.renameInline(id, label));
      return row;
    };
    const scene = this.scene;
    const sceneRow = h("div", { class: `pt-tree-row${this.selection === null ? " pt-selected" : ""}`, role: "treeitem", tabindex: "0" }, icon("scene"), h("span", { class: "pt-tree-name" }, `${scene.name} settings`));
    sceneRow.addEventListener("click", () => this.select(null));
    tree.replaceChildren(
      sceneRow,
      h("div", { class: "pt-tree-group" }, `Lights (${scene.lights.length})`),
      ...scene.lights.map((l) => rowFor(l.id, LIGHT_ICONS[l.type], l.name, l.enabled, () => (l.enabled = !l.enabled), l.enabled ? "Turn off" : "Turn on")),
      h("div", { class: "pt-tree-group" }, `Objects (${scene.objects.length})`),
      ...scene.objects.map((o) => rowFor(o.id, o.shape, o.name, o.visible, () => (o.visible = !o.visible), o.visible ? "Hide" : "Show")),
    );
    // Scroll the tree only (scrollIntoView would also scroll the host page when embedded).
    const selectedRow = tree.querySelector<HTMLElement>(".pt-selected");
    if (selectedRow) {
      const top = selectedRow.offsetTop - tree.offsetTop;
      if (top < tree.scrollTop) tree.scrollTop = top;
      else if (top + selectedRow.offsetHeight > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + selectedRow.offsetHeight - tree.clientHeight;
    }
  }

  private renameInline(id: string, label: HTMLElement): void {
    const found = findItem(this.scene, id);
    if (!found) return;
    const input = h("input", { class: "pt-rename", value: found.item.name, spellcheck: "false" });
    label.replaceWith(input);
    input.focus();
    input.select();
    const done = (apply: boolean): void => {
      if (apply && input.value.trim()) found.item.name = input.value.trim();
      this.commit();
      this.renderInspector();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") {
        input.value = found.item.name;
        input.blur();
      }
    });
    input.addEventListener("blur", () => done(true), { once: true });
  }

  /* ========================================================== materials */

  private renderSwatches(): void {
    const scene = this.scene;
    const selected = this.selection;
    const sel = selected?.type === "item" ? findItem(scene, selected.id) : null;
    const activeMaterial = selected?.type === "material" ? selected.id : sel?.kind === "object" ? sel.item.materialId : null;
    const keep = new Set<string>();
    const nodes: HTMLElement[] = [];
    for (const material of scene.materials) {
      keep.add(material.id);
      let entry = this.swatchCache.get(material.id);
      if (!entry) {
        const canvas = h("canvas", { width: 64, height: 64 });
        const el = h("button", { type: "button", class: "pt-swatch", draggable: "true" }, canvas, h("span", {}));
        el.addEventListener("click", () => this.onSwatchClick(material.id));
        el.addEventListener("dblclick", () => this.select(material.id));
        el.addEventListener("dragstart", (e) => {
          e.dataTransfer?.setData("application/x-pt-material", material.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
        });
        entry = { el, canvas, key: "" };
        this.swatchCache.set(material.id, entry);
      }
      const label = entry.el.querySelector("span");
      if (label) label.textContent = material.name;
      entry.el.title = `${material.name}: click to ${sel?.kind === "object" ? "assign to the selection" : "edit"}, drag onto an object to assign`;
      entry.el.classList.toggle("pt-selected", material.id === activeMaterial);
      entry.el.classList.toggle("pt-used", scene.objects.some((o) => o.materialId === material.id));
      nodes.push(entry.el);
    }
    for (const id of [...this.swatchCache.keys()]) if (!keep.has(id)) this.swatchCache.delete(id);
    this.ui.swatches.replaceChildren(...nodes);
    this.schedulePreviews(0);
  }

  private onSwatchClick(materialId: string): void {
    const sel = this.selection?.type === "item" ? findItem(this.scene, this.selection.id) : null;
    if (sel?.kind === "object") {
      if (sel.item.materialId !== materialId) {
        sel.item.materialId = materialId;
        this.commit();
        this.renderInspector();
      }
      return;
    }
    this.select(materialId);
  }

  /** Re-renders the thumbnails whose material changed, after a short pause in editing. */
  private schedulePreviews(delay = 180): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      if (this.disposed) return;
      for (const material of this.scene.materials) {
        const entry = this.swatchCache.get(material.id);
        const key = materialKey(material);
        if (entry && entry.key !== key) {
          entry.key = key;
          void renderMaterialPreview(material, entry.canvas, { samples: 48 });
        }
      }
      const p = this.inspectorPreview;
      if (p) {
        const material = this.scene.materials.find((m) => m.id === p.materialId);
        const key = material ? materialKey(material) : "";
        if (material && p.key !== key) {
          p.key = key;
          void renderMaterialPreview(material, p.canvas, { samples: 128 });
        }
      }
    }, delay);
  }

  /* ========================================================== inspector */

  private renderInspector(): void {
    const panel = this.ui.inspector;
    this.fields = [];
    this.inspectorPreview = null;
    panel.replaceChildren();
    const sel = this.selection;
    if (sel?.type === "material") {
      const material = this.scene.materials.find((m) => m.id === sel.id);
      if (material) {
        panel.append(this.head("material", material.name, "Material"), ...this.materialSections(material, true));
      }
    } else if (sel?.type === "item") {
      const found = findItem(this.scene, sel.id);
      if (found?.kind === "object") panel.append(...this.objectInspector(found.item));
      else if (found?.kind === "light") panel.append(...this.lightInspector(found.item));
    } else {
      panel.append(...this.sceneInspector());
    }
    this.schedulePreviews(0);
  }

  private head(iconName: string, title: string, kind: string): HTMLElement {
    return h("div", { class: "pt-inspector-head" }, icon(iconName), h("h2", {}, title), h("span", { class: "pt-kind" }, kind));
  }

  private add<T extends Field>(field: T): HTMLElement {
    this.fields.push(field);
    return field.el;
  }

  private body(...children: (HTMLElement | null)[]): HTMLElement {
    return h("div", { class: "pt-section-body" }, ...children);
  }

  private objectInspector(o: SceneObject): HTMLElement[] {
    const hk = this.hooks();
    const renamed: FieldHooks = { onInput: hk.onInput, onCommit: () => (this.commit(), this.renderInspector()) };
    const material = findMaterial(this.scene, o.materialId);
    const users = this.scene.objects.filter((x) => x.materialId === material.id).length;

    const pick = h("select", { class: "pt-select", "aria-label": "Material" }, ...this.scene.materials.map((m) => h("option", { value: m.id }, m.name)));
    pick.value = material.id;
    pick.addEventListener("change", () => {
      o.materialId = pick.value;
      this.commit();
      this.renderInspector();
    });
    const unique = iconButton("copy", "Make a unique copy of this material for this object", () => {
      const copy: Material = { ...structuredClone(material), id: uid("mat"), name: this.uniqueName(`${material.name} copy`, this.scene.materials) };
      this.scene.materials.push(copy);
      o.materialId = copy.id;
      this.commit();
      this.renderInspector();
    });
    const fresh = iconButton("plus", "New material from a preset", (e) => this.openMaterialMenu(e.currentTarget as HTMLElement));

    return [
      this.head(o.shape, o.name, SHAPE_LABELS[o.shape]),
      section(
        "Object",
        this.body(
          this.add(textField("Name", () => o.name, (v) => (o.name = v), renamed)),
          this.add(selectField("Shape", SHAPES.map((s) => ({ value: s, label: SHAPE_LABELS[s] })), () => o.shape, (v) => (o.shape = v), renamed)),
          this.add(toggleField("Visible", () => o.visible, (v) => (o.visible = v), hk)),
        ),
      ),
      section(
        "Transform",
        this.body(
          this.add(vec3Field("Position", () => o.position, (v) => (o.position = v), hk, { step: 0.01, precision: 3 })),
          this.add(vec3Field("Rotation", () => o.rotation, (v) => (o.rotation = v), hk, { step: 0.5, precision: 1, suffix: "°" })),
          this.add(vec3Field("Size", () => o.scale, (v) => (o.scale = v.map((x) => Math.max(0.001, x)) as Vec3), hk, { step: 0.01, precision: 3, min: 0.001 })),
          h("div", { class: "pt-actions" },
            h("button", { type: "button", class: "pt-btn", onclick: () => this.frameSelection() }, icon("focus"), "Frame"),
            h("button", { type: "button", class: "pt-btn", onclick: () => this.duplicate(o.id) }, icon("copy"), "Duplicate"),
            h("button", { type: "button", class: "pt-btn", onclick: () => this.remove(o.id) }, icon("trash"), "Remove"),
          ),
        ),
      ),
      section(
        "Material",
        this.body(
          h("div", { class: "pt-material-pick" }, pick, unique, fresh),
          users > 1 ? h("p", { class: "pt-note" }, `Shared by ${users} objects: changes apply to all of them. Use the copy button to edit this object alone.`) : null,
        ),
      ),
      ...this.materialSections(material, false),
    ];
  }

  private materialSections(m: Material, standalone: boolean): HTMLElement[] {
    const hk = this.hooks();
    const renamed: FieldHooks = { onInput: hk.onInput, onCommit: () => (this.commit(), this.renderInspector()) };
    const slider = { min: 0, max: 1, step: 0.01, precision: 2, slider: true };
    const preview = h("canvas", { class: "pt-preview", width: 320, height: 200 });
    this.inspectorPreview = { canvas: preview, materialId: m.id, key: "" };
    const users = this.scene.objects.filter((o) => o.materialId === m.id).length;

    return [
      section(
        standalone ? "Material" : "Surface",
        this.body(
          preview,
          standalone ? this.add(textField("Name", () => m.name, (v) => (m.name = v), renamed)) : this.add(textField("Material", () => m.name, (v) => (m.name = v), renamed)),
          this.add(colorField("Base color", () => m.baseColor, (v) => (m.baseColor = v), hk)),
          this.add(numberField("Metallic", () => m.metallic, (v) => (m.metallic = v), hk, slider)),
          this.add(numberField("Roughness", () => m.roughness, (v) => (m.roughness = v), hk, slider)),
          this.add(numberField("Specular", () => m.specular, (v) => (m.specular = v), hk, slider)),
        ),
      ),
      section(
        "Transmission",
        this.body(
          this.add(numberField("Transmission", () => m.transmission, (v) => (m.transmission = v), hk, slider)),
          this.add(numberField("IOR", () => m.ior, (v) => (m.ior = v), hk, { min: 1, max: 3, step: 0.01, precision: 3, slider: true })),
        ),
      ),
      section(
        "Clearcoat",
        this.body(
          this.add(numberField("Clearcoat", () => m.clearcoat, (v) => (m.clearcoat = v), hk, slider)),
          this.add(numberField("Coat rough.", () => m.clearcoatRoughness, (v) => (m.clearcoatRoughness = v), hk, slider)),
        ),
      ),
      section(
        "Emission",
        this.body(
          this.add(colorField("Color", () => m.emission, (v) => (m.emission = v), hk)),
          this.add(numberField("Strength", () => m.emissionStrength, (v) => (m.emissionStrength = v), hk, { min: 0, max: 1000, step: 0.05, precision: 2 })),
        ),
      ),
      section(
        "Pattern",
        this.body(
          this.add(selectField("Pattern", [{ value: "none", label: "None" }, { value: "checker", label: "Checker" }] as const, () => m.pattern, (v) => (m.pattern = v), hk)),
          this.add(colorField("Color", () => m.patternColor, (v) => (m.patternColor = v), hk)),
          this.add(numberField("Cells / unit", () => m.patternScale, (v) => (m.patternScale = v), hk, { min: 0.01, max: 1000, step: 0.1, precision: 2 })),
        ),
      ),
      ...(standalone
        ? [
            section(
              "Usage",
              this.body(
                h("p", { class: "pt-note" }, users === 0 ? "Not used by any object yet. Drag the swatch onto an object, or select an object and click the swatch." : `Used by ${users} object${users > 1 ? "s" : ""}.`),
                h("div", { class: "pt-actions" },
                  h("button", {
                    type: "button",
                    class: "pt-btn",
                    onclick: () => {
                      const copy: Material = { ...structuredClone(m), id: uid("mat"), name: this.uniqueName(`${m.name} copy`, this.scene.materials) };
                      this.scene.materials.push(copy);
                      this.commit();
                      this.select(copy.id);
                    },
                  }, icon("copy"), "Duplicate"),
                  h("button", { type: "button", class: "pt-btn", onclick: () => this.remove(m.id) }, icon("trash"), "Delete"),
                ),
              ),
            ),
          ]
        : []),
    ];
  }

  private lightInspector(l: Light): HTMLElement[] {
    const hk = this.hooks();
    const structural: FieldHooks = { onInput: hk.onInput, onCommit: () => (this.commit(), this.renderInspector()) };
    const intensityLabel = l.type === "sun" ? "Irradiance" : l.type === "point" ? "Intensity" : "Radiance";
    return [
      this.head(LIGHT_ICONS[l.type], l.name, LIGHT_LABELS[l.type]),
      section(
        "Light",
        this.body(
          this.add(textField("Name", () => l.name, (v) => (l.name = v), structural)),
          this.add(selectField("Type", LIGHT_TYPES.map((t) => ({ value: t, label: LIGHT_LABELS[t] })), () => l.type, (v) => (l.type = v), structural)),
          this.add(toggleField("Enabled", () => l.enabled, (v) => (l.enabled = v), structural)),
          l.type === "area" || l.type === "sphere" ? this.add(toggleField("Seen by camera", () => l.visible, (v) => (l.visible = v), hk)) : null,
          this.add(colorField("Color", () => l.color, (v) => (l.color = v), hk)),
          this.add(numberField(intensityLabel, () => l.intensity, (v) => (l.intensity = v), hk, { min: 0, max: 100000, step: 0.1, precision: 2 })),
          l.type === "area" ? this.add(numberField("Width", () => l.size[0], (v) => (l.size = [Math.max(0.001, v), l.size[1]]), hk, { min: 0.001, step: 0.01, precision: 3 })) : null,
          l.type === "area" ? this.add(numberField("Depth", () => l.size[1], (v) => (l.size = [l.size[0], Math.max(0.001, v)]), hk, { min: 0.001, step: 0.01, precision: 3 })) : null,
          l.type === "sphere" ? this.add(numberField("Radius", () => l.radius, (v) => (l.radius = v), hk, { min: 0.001, step: 0.005, precision: 3 })) : null,
          l.type === "sun" ? this.add(numberField("Angle", () => l.angle, (v) => (l.angle = v), hk, { min: 0, max: 30, step: 0.05, precision: 2, suffix: "°" })) : null,
          h("p", { class: "pt-note" }, l.type === "sun" ? "A sun lights the scene from infinitely far away along its -Y axis; its position only places the handle." : l.type === "area" ? "Area lights shine along their local -Y axis and are invisible from behind." : l.type === "point" ? "Point lights are infinitely small: sharp shadows, no visible emitter." : "Sphere lights cast soft shadows proportional to their radius."),
        ),
      ),
      section(
        "Transform",
        this.body(
          this.add(vec3Field("Position", () => l.position, (v) => (l.position = v), hk, { step: 0.01, precision: 3 })),
          l.type === "area" || l.type === "sun" ? this.add(vec3Field("Rotation", () => l.rotation, (v) => (l.rotation = v), hk, { step: 0.5, precision: 1, suffix: "°" })) : null,
          h("div", { class: "pt-actions" },
            h("button", { type: "button", class: "pt-btn", onclick: () => this.setLightFollow(!this.viewer.lightFollow) }, icon("follow"), "Follow pointer"),
            h("button", { type: "button", class: "pt-btn", onclick: () => this.duplicate(l.id) }, icon("copy"), "Duplicate"),
            h("button", { type: "button", class: "pt-btn", onclick: () => this.remove(l.id) }, icon("trash"), "Remove"),
          ),
        ),
      ),
    ];
  }

  private sceneInspector(): HTMLElement[] {
    const s = this.scene;
    const hk = this.hooks();
    const structural: FieldHooks = { onInput: hk.onInput, onCommit: () => (this.commit(), this.renderInspector()) };
    const env = s.environment;
    const qualityOptions = [
      { value: "1", label: "Full" },
      { value: "0.75", label: "75%" },
      { value: "0.5", label: "50%" },
      { value: "0.35", label: "35%" },
    ] as const;
    const quality: Field = selectField(
      "Resolution",
      qualityOptions,
      () => (String(this.viewer.resolutionScale) as (typeof qualityOptions)[number]["value"]),
      (v) => {
        this.viewer.resolutionScale = Number(v);
        this.viewer.fit();
      },
      { onInput: () => undefined, onCommit: () => undefined },
    );
    return [
      this.head("scene", s.name, "Scene"),
      section("Scene", this.body(this.add(textField("Name", () => s.name, (v) => (s.name = v), structural)))),
      section(
        "Camera",
        this.body(
          this.add(numberField("Field of view", () => s.camera.fov, (v) => (s.camera.fov = v), hk, { min: 5, max: 150, step: 0.5, precision: 1, suffix: "°" })),
          this.add(numberField("Aperture", () => s.camera.aperture, (v) => (s.camera.aperture = v), hk, { min: 0, max: 0.5, step: 0.002, precision: 3 })),
          this.add(numberField("Focus dist.", () => s.camera.focusDistance, (v) => (s.camera.focusDistance = v), hk, { min: 0, step: 0.01, precision: 3 })),
          h("p", { class: "pt-note" }, "Aperture above 0 enables depth of field. Focus distance 0 focuses on the orbit target; Alt + click a surface to focus on it."),
        ),
      ),
      section(
        "Environment",
        this.body(
          this.add(selectField("Background", [{ value: "color", label: "Color" }, { value: "sky", label: "Sky gradient" }] as const, () => env.type, (v) => (env.type = v), structural)),
          ...(env.type === "color"
            ? [this.add(colorField("Color", () => env.color, (v) => (env.color = v), hk))]
            : [
                this.add(colorField("Zenith", () => env.zenith, (v) => (env.zenith = v), hk)),
                this.add(colorField("Horizon", () => env.horizon, (v) => (env.horizon = v), hk)),
                this.add(colorField("Ground", () => env.ground, (v) => (env.ground = v), hk)),
              ]),
          this.add(numberField("Intensity", () => env.intensity, (v) => (env.intensity = v), hk, { min: 0, max: 100, step: 0.01, precision: 2 })),
        ),
      ),
      section(
        "Render",
        this.body(
          this.add(numberField("Exposure", () => s.render.exposure, (v) => (s.render.exposure = v), hk, { min: -6, max: 6, step: 0.05, precision: 2, suffix: " EV" })),
          this.add(selectField("Tone mapping", TONE_MAPPINGS.map((t) => ({ value: t, label: t === "aces" ? "ACES" : t === "reinhard" ? "Reinhard" : "Linear (clip)" })), () => s.render.toneMapping, (v) => (s.render.toneMapping = v), hk)),
          this.add(numberField("Bounces", () => s.render.maxBounces, (v) => (s.render.maxBounces = Math.round(v)), hk, { min: 1, max: 32, step: 1, precision: 0 })),
          this.add(numberField("Max samples", () => s.render.maxSamples, (v) => (s.render.maxSamples = Math.round(v)), hk, { min: 0, max: 1000000, step: 16, precision: 0 })),
          this.add(numberField("Firefly clamp", () => s.render.clamp, (v) => (s.render.clamp = v), hk, { min: 0, max: 1000, step: 0.5, precision: 1 })),
          this.add(quality),
          h("p", { class: "pt-note" }, "Max samples 0 refines forever. A lower firefly clamp converges faster but darkens caustics. Press ? for keyboard shortcuts."),
        ),
      ),
    ];
  }

  /* ============================================================ overlay */

  private readonly drawOverlay = (): void => {
    if (this.disposed) return;
    this.overlayHandle = requestAnimationFrame(this.drawOverlay);
    this.gizmo.draw();
  };
}
