/**
 * Custom elements wrapping the viewer, the editor and material previews, so the
 * path tracer can be used from plain HTML or any framework:
 *
 *   <pt-viewer src="scene.json" light-follow></pt-viewer>
 *   <pt-editor storage-key="my-scene"></pt-editor>
 *   <pt-material-preview preset="gold"></pt-material-preview>
 *
 * A scene can come from `src` (URL of a JSON file), `preset` (a built-in scene id),
 * the `scene` property, or an inline <script type="application/json"> child.
 */

import { Editor } from "../editor/editor";
import { MATERIAL_PRESETS } from "../core/presets";
import { scenePreset } from "../core/presets";
import { normalizeMaterial, normalizeScene, SHAPES, type Material, type Scene, type ShapeType } from "../core/scene";
import { sceneFromHash } from "../core/share";
import { renderMaterialPreview } from "../preview/preview";
import { Viewer } from "../viewer/viewer";

async function resolveScene(el: HTMLElement): Promise<Scene | null> {
  const inline = el.querySelector('script[type="application/json"]');
  if (inline?.textContent?.trim()) {
    try {
      return normalizeScene(JSON.parse(inline.textContent));
    } catch {
      console.warn("[path-tracer] Invalid inline scene JSON", el);
    }
  }
  const src = el.getAttribute("src");
  if (src) {
    if (src.startsWith("#")) return sceneFromHash(src);
    const response = await fetch(src);
    if (!response.ok) throw new Error(`Could not load ${src} (${response.status})`);
    return normalizeScene(await response.json());
  }
  const preset = el.getAttribute("preset");
  if (preset) return scenePreset(preset);
  return null;
}

const HOST_STYLE = `
  :host { display: block; position: relative; min-height: 160px; contain: content; background: #000; }
  :host([hidden]) { display: none; }
  .view { position: absolute; inset: 0; }
  .error { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; color: #ddd; font: 13px system-ui, sans-serif; text-align: center; }
`;

/**
 * `<pt-viewer>`: an interactive, progressively refined render of a scene.
 * Attributes: src, preset, controls ("false" disables them), light-follow,
 * resolution-scale, max-samples, exposure. Events: pt-ready, pt-frame, pt-change.
 */
export class PathTracerViewerElement extends HTMLElement {
  static observedAttributes = ["src", "preset", "controls", "light-follow", "resolution-scale", "max-samples", "exposure"];

  viewer: Viewer | null = null;
  private pending: Scene | null = null;
  private readonly mount: HTMLDivElement;
  private loadToken = 0;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    this.mount = document.createElement("div");
    this.mount.className = "view";
    root.append(style, this.mount);
  }

  /** The live scene (mutations are picked up on the next frame). */
  get scene(): Scene | null {
    return this.viewer?.scene ?? this.pending;
  }

  set scene(value: Scene | object | null) {
    if (!value) return;
    const scene = normalizeScene(value);
    if (this.viewer) this.viewer.setScene(scene);
    else this.pending = scene;
    this.applyAttributes();
  }

  connectedCallback(): void {
    if (!this.viewer) {
      this.viewer = new Viewer(this.mount, { scene: this.pending ?? scenePreset("studio") });
      this.viewer.on("frame", (detail) => this.dispatchEvent(new CustomEvent("pt-frame", { detail })));
      this.viewer.on("change", (detail) => this.dispatchEvent(new CustomEvent("pt-change", { detail })));
      this.viewer.on("error", ({ message }) => this.showError(message));
      this.applyAttributes();
      if (!this.pending) void this.load();
      else this.dispatchEvent(new CustomEvent("pt-ready"));
    }
  }

  disconnectedCallback(): void {
    // Defer so moving the element in the DOM does not throw away its WebGL context.
    queueMicrotask(() => {
      if (!this.isConnected) {
        this.viewer?.dispose();
        this.viewer = null;
      }
    });
  }

  attributeChangedCallback(name: string): void {
    if (!this.viewer) return;
    if (name === "src" || name === "preset") void this.load();
    else this.applyAttributes();
  }

  /** PNG snapshot of the current image. */
  toBlob(type?: string, quality?: number): Promise<Blob> {
    if (!this.viewer) return Promise.reject(new Error("Viewer not connected"));
    return this.viewer.toBlob(type, quality);
  }

  private async load(): Promise<void> {
    const token = ++this.loadToken;
    try {
      const scene = await resolveScene(this);
      if (token !== this.loadToken || !this.viewer) return;
      if (scene) this.viewer.setScene(scene);
      this.applyAttributes();
      this.dispatchEvent(new CustomEvent("pt-ready"));
    } catch (err) {
      this.showError(String(err instanceof Error ? err.message : err));
    }
  }

  private applyAttributes(): void {
    const v = this.viewer;
    if (!v) return;
    v.controls = this.getAttribute("controls") !== "false";
    v.lightFollow = this.hasAttribute("light-follow") && this.getAttribute("light-follow") !== "false";
    const scale = Number(this.getAttribute("resolution-scale"));
    if (scale > 0) {
      v.resolutionScale = Math.min(1, Math.max(0.25, scale));
      v.fit();
    }
    const max = this.getAttribute("max-samples");
    if (max !== null && Number.isFinite(Number(max))) v.scene.render.maxSamples = Math.max(0, Math.round(Number(max)));
    const exposure = this.getAttribute("exposure");
    if (exposure !== null && Number.isFinite(Number(exposure))) v.scene.render.exposure = Number(exposure);
  }

  private showError(message: string): void {
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = message;
    this.shadowRoot?.append(box);
  }
}

/**
 * `<pt-editor>`: the full editor. Attributes: src, preset, storage-key, base-url, light-follow.
 * Events: pt-change (finished edit), pt-input (live edit), pt-select. Property: editor.
 */
export class PathTracerEditorElement extends HTMLElement {
  editor: Editor | null = null;
  private pending: Scene | null = null;

  get scene(): Scene | null {
    return this.editor?.scene ?? this.pending;
  }

  set scene(value: Scene | object | null) {
    if (!value) return;
    const scene = normalizeScene(value);
    if (this.editor) this.editor.setScene(scene);
    else this.pending = scene;
  }

  connectedCallback(): void {
    if (this.editor) return;
    if (!this.style.display) this.style.display = "block";
    if (!this.style.height && this.clientHeight === 0) this.style.height = "640px";
    const storageKey = this.getAttribute("storage-key");
    this.editor = new Editor(this, {
      scene: this.pending ?? undefined,
      storageKey,
      baseUrl: this.getAttribute("base-url") ?? undefined,
      lightFollow: this.hasAttribute("light-follow"),
    });
    this.editor.on("change", (detail) => this.dispatchEvent(new CustomEvent("pt-change", { detail })));
    this.editor.on("input", (detail) => this.dispatchEvent(new CustomEvent("pt-input", { detail })));
    this.editor.on("select", (detail) => this.dispatchEvent(new CustomEvent("pt-select", { detail })));
    const hasStored = !!storageKey && (() => {
      try {
        return localStorage.getItem(storageKey) !== null;
      } catch {
        return false;
      }
    })();
    if (!this.pending && !hasStored) {
      void resolveScene(this).then((scene) => {
        if (scene && this.editor) this.editor.setScene(scene);
        this.dispatchEvent(new CustomEvent("pt-ready"));
      });
    } else {
      this.dispatchEvent(new CustomEvent("pt-ready"));
    }
  }

  disconnectedCallback(): void {
    queueMicrotask(() => {
      if (!this.isConnected) {
        this.editor?.dispose();
        this.editor = null;
      }
    });
  }
}

/**
 * `<pt-material-preview>`: a path traced material ball.
 * Attributes: preset (see MATERIAL_PRESETS), material (JSON), shape, samples, background ("studio" or "dark").
 * Property: material. All previews on a page share a single WebGL context.
 */
export class PathTracerMaterialPreviewElement extends HTMLElement {
  static observedAttributes = ["preset", "material", "shape", "samples", "background"];

  private readonly canvas: HTMLCanvasElement;
  private _material: Partial<Material> | null = null;
  private queued = false;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host { display: inline-block; width: 128px; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: #1a1a1a; vertical-align: middle; }
      canvas { display: block; width: 100%; height: 100%; }`;
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("role", "img");
    root.append(style, this.canvas);
  }

  get material(): Partial<Material> {
    if (this._material) return this._material;
    const json = this.getAttribute("material");
    if (json) {
      try {
        return normalizeMaterial(JSON.parse(json));
      } catch {
        console.warn("[path-tracer] Invalid material JSON", this);
      }
    }
    const preset = MATERIAL_PRESETS.find((p) => p.id === this.getAttribute("preset"));
    return preset ? { name: preset.label, ...preset.material } : {};
  }

  set material(value: Partial<Material>) {
    this._material = value;
    this.update();
  }

  connectedCallback(): void {
    this.update();
  }

  attributeChangedCallback(): void {
    this.update();
  }

  /** Re-renders on the next frame (several changes in a row cost one render). */
  update(): void {
    if (this.queued || !this.isConnected) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      const material = this.material;
      this.canvas.setAttribute("aria-label", `Material preview: ${material.name ?? "material"}`);
      const shape = this.getAttribute("shape") as ShapeType | null;
      void renderMaterialPreview(material, this.canvas, {
        samples: Number(this.getAttribute("samples")) || 96,
        shape: shape && SHAPES.includes(shape) ? shape : "sphere",
        background: this.getAttribute("background") === "dark" ? "dark" : "studio",
      }).then(() => this.dispatchEvent(new CustomEvent("pt-rendered")));
    });
  }
}

/** Registers <pt-viewer>, <pt-editor> and <pt-material-preview> (safe to call more than once). */
export function defineElements(prefix = "pt"): void {
  const define = (name: string, ctor: CustomElementConstructor): void => {
    if (!customElements.get(name)) customElements.define(name, ctor);
  };
  define(`${prefix}-viewer`, class extends PathTracerViewerElement {});
  define(`${prefix}-editor`, class extends PathTracerEditorElement {});
  define(`${prefix}-material-preview`, class extends PathTracerMaterialPreviewElement {});
}

declare global {
  interface HTMLElementTagNameMap {
    "pt-viewer": PathTracerViewerElement;
    "pt-editor": PathTracerEditorElement;
    "pt-material-preview": PathTracerMaterialPreviewElement;
  }
}
