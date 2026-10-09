import { cameraRay, orbit, pan, projectPoint, viewTanHalf, zoom, type Ray } from "../core/camera";
import { Emitter } from "../core/emitter";
import { raycast, sceneBounds, type RayHit } from "../core/geometry";
import { clamp, madd, type Vec3 } from "../core/math";
import { scenePreset } from "../core/presets";
import { cloneScene, normalizeScene, type Camera, type Light, type Scene } from "../core/scene";
import { GLError } from "../render/gl";
import { Renderer } from "../render/renderer";

export interface ViewerOptions {
  /** Scene to show. Anything JSON-like is accepted and normalized. Defaults to the "studio" preset. */
  scene?: Scene | object;
  /** Orbit, pan and zoom with mouse, touch and keyboard. Default true. */
  controls?: boolean;
  /** The active light follows the pointer while hovering (one finger on touch screens). Default false. */
  lightFollow?: boolean;
  /** Upper bound for the device pixel ratio. Default 2. */
  maxPixelRatio?: number;
  /** Fraction of the pixel size actually traced, 0.25 to 1. Default 1. */
  resolutionScale?: number;
  /** Upper bound of path tracing passes per animation frame (adapted to the GPU speed). Default 8. */
  maxPassesPerFrame?: number;
  /** Pause rendering while the viewer is scrolled out of view. Default true. */
  pauseWhenHidden?: boolean;
}

export interface FrameInfo {
  samples: number;
  samplesPerSecond: number;
  converged: boolean;
  width: number;
  height: number;
}

export type ViewerEvents = {
  /** After each rendered frame. */
  frame: FrameInfo;
  /** The viewer itself changed the scene (camera move, light follow). */
  change: { source: "camera" | "light" };
  /** WebGL could not start or the context was lost. */
  error: { message: string };
  /** A click or tap on the canvas that did not turn into a camera drag. */
  tap: { clientX: number; clientY: number; button: number; altKey: boolean; shiftKey: boolean };
};

/**
 * Pointer interaction plugged in front of the camera controls (used by the editor gizmos).
 * Return true from `down` to own the pointer until it is released.
 */
export interface PointerTool {
  down?(event: PointerEvent): boolean;
  move?(event: PointerEvent): void;
  up?(event: PointerEvent): void;
  /** Mouse hover without buttons. Return true to stop the light follow behavior. */
  hover?(event: PointerEvent): boolean;
  leave?(): void;
}

type Drag = { mode: "orbit" | "pan"; x: number; y: number; moved: number };

/**
 * A self-contained path traced view: it owns a canvas inside `container`,
 * the render loop and the camera controls. The scene is a plain object that
 * can be mutated in place; the viewer notices changes on the next frame.
 */
export class Viewer extends Emitter<ViewerEvents> {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  renderer: Renderer | null = null;

  controls: boolean;
  lightFollow: boolean;
  resolutionScale: number;
  maxPassesPerFrame: number;
  paused = false;
  /** Chooses which light follows the pointer. Defaults to the first enabled non-sun light. */
  lightFollowTarget: (scene: Scene) => Light | null = (scene) =>
    scene.lights.find((l) => l.enabled && l.type !== "sun") ?? null;

  private _scene: Scene;
  private homeCamera: Camera;
  private readonly maxPixelRatio: number;
  private readonly tools: PointerTool[] = [];
  private activeTool: PointerTool | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag | null = null;
  private pinch: { distance: number; x: number; y: number } | null = null;
  private frameHandle = 0;
  private passes = 1;
  private lastFrame = 0;
  private frameTime = 16;
  private gpuBehind = false;
  private rateStart = 0;
  private rateSamples = 0;
  private samplesPerSecond = 0;
  private onScreen = true;
  private disposed = false;
  private lastPresented = { exposure: NaN, toneMapping: "" };
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver | null;

  constructor(container: HTMLElement, options: ViewerOptions = {}) {
    super();
    this.container = container;
    this._scene = options.scene ? normalizeScene(options.scene) : scenePreset("studio");
    this.homeCamera = structuredClone(this._scene.camera);
    this.controls = options.controls ?? true;
    this.lightFollow = options.lightFollow ?? false;
    this.resolutionScale = clamp(options.resolutionScale ?? 1, 0.25, 1);
    this.maxPassesPerFrame = Math.max(1, Math.round(options.maxPassesPerFrame ?? 8));
    this.maxPixelRatio = options.maxPixelRatio ?? 2;

    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Path traced scene. Drag to orbit, right drag to pan, scroll to zoom.");
    Object.assign(this.canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
      touchAction: "none",
      outline: "none",
      cursor: "grab",
    });
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    container.appendChild(this.canvas);

    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.createRenderer();

    const c = this.canvas;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("pointerleave", this.onPointerLeave);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("dblclick", this.onDoubleClick);
    c.addEventListener("keydown", this.onKeyDown);
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(container);
    this.intersectionObserver =
      options.pauseWhenHidden === false || typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            this.onScreen = entries.some((e) => e.isIntersecting);
          });
    this.intersectionObserver?.observe(this.canvas);
    this.fit();
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  /* --------------------------------------------------------------- scene */

  get scene(): Scene {
    return this._scene;
  }

  /**
   * Replaces the scene. By default its camera becomes the "home" camera used by
   * double click and the 0 key; pass `{ keepHome: true }` to keep the previous one.
   */
  setScene(scene: Scene | object, options: { keepHome?: boolean } = {}): void {
    this._scene = normalizeScene(scene);
    if (!options.keepHome) this.homeCamera = structuredClone(this._scene.camera);
    this.renderer?.reset();
  }

  /** A deep copy of the current scene, safe to serialize or store. */
  getScene(): Scene {
    return cloneScene(this._scene);
  }

  /** Restarts the accumulation. Changes are detected automatically, so this is rarely needed. */
  restart(): void {
    this.renderer?.reset();
  }

  resetCamera(): void {
    this._scene.camera = structuredClone(this.homeCamera);
    this.emit("change", { source: "camera" });
  }

  get samples(): number {
    return this.renderer?.samples ?? 0;
  }

  /* ----------------------------------------------------------- geometry */

  /** Size of the canvas in CSS pixels. */
  get size(): { width: number; height: number } {
    return { width: this.canvas.clientWidth || 1, height: this.canvas.clientHeight || 1 };
  }

  /** World ray through a point given in client (viewport) coordinates. */
  rayAt(clientX: number, clientY: number): Ray {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    return cameraRay(this._scene.camera, nx, ny, rect.width / rect.height);
  }

  /** What is under a client point: an object, a light, or null. */
  pick(clientX: number, clientY: number): RayHit | null {
    return raycast(this._scene, this.rayAt(clientX, clientY), { handleRadius: this.handleRadius() });
  }

  /** Projects a world point to canvas CSS pixels. `visible` is false behind the camera. */
  project(point: Vec3): { x: number; y: number; depth: number; visible: boolean } {
    const { width, height } = this.size;
    const p = projectPoint(this._scene.camera, point, width / height);
    return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height, depth: p.depth, visible: p.depth > 1e-3 };
  }

  /* ------------------------------------------------------------- output */

  /** PNG (or other type) of the current image. */
  toBlob(type = "image/png", quality?: number): Promise<Blob> {
    this.renderer?.present();
    return new Promise((resolve, reject) =>
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Snapshot failed"))), type, quality),
    );
  }

  /* -------------------------------------------------------------- tools */

  addTool(tool: PointerTool): () => void {
    this.tools.push(tool);
    return () => {
      const i = this.tools.indexOf(tool);
      if (i >= 0) this.tools.splice(i, 1);
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas.remove();
  }

  /* ----------------------------------------------------------- internals */

  private createRenderer(): void {
    try {
      this.renderer = new Renderer(this.canvas);
    } catch (err) {
      this.renderer = null;
      const message = err instanceof GLError ? err.message : `Unexpected error: ${String(err)}`;
      queueMicrotask(() => this.emit("error", { message }));
    }
  }

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.renderer = null;
    this.emit("error", { message: "The GPU context was lost. It will be restored automatically." });
  };

  private readonly onContextRestored = (): void => {
    this.createRenderer();
    this.fit(true);
  };

  /** Matches the drawing buffer to the element size. */
  fit(force = false): void {
    if (!this.renderer) return;
    const ratio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) * this.resolutionScale;
    const { width, height } = this.size;
    if (force) this.renderer.reset();
    this.renderer.resize(width * ratio, height * ratio);
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.frame);
    const renderer = this.renderer;
    if (!renderer) return;

    const dt = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    this.frameTime = this.frameTime * 0.8 + dt * 0.2;

    if (this.paused || document.hidden || !this.onScreen) return;

    // GPU still busy with the last frame: wait instead of piling up work, and do less next time.
    if (renderer.busy()) {
      this.passes = Math.max(1, this.passes - 1);
      this.gpuBehind = true;
      return;
    }
    const changed = renderer.sync(this._scene);
    const max = this._scene.render.maxSamples;
    const converged = max > 0 && renderer.samples >= max;
    if (converged) {
      if (renderer.exposure !== this.lastPresented.exposure || renderer.toneMapping !== this.lastPresented.toneMapping) {
        renderer.present();
        this.lastPresented = { exposure: renderer.exposure, toneMapping: renderer.toneMapping };
      }
      return;
    }

    // Adapt the work per frame: one pass while the image changes, more when idle and the GPU keeps up.
    if (changed || renderer.samples < 4) this.passes = 1;
    else if (!this.gpuBehind && this.frameTime < 20 && this.passes < this.maxPassesPerFrame) this.passes++;
    else if (this.frameTime > 30 && this.passes > 1) this.passes--;
    this.gpuBehind = false;
    const passes = max > 0 ? Math.min(this.passes, max - renderer.samples) : this.passes;
    renderer.render(passes);
    this.lastPresented = { exposure: renderer.exposure, toneMapping: renderer.toneMapping };

    if (changed) {
      this.rateStart = now;
      this.rateSamples = 0;
    }
    this.rateSamples += passes;
    if (now - this.rateStart > 500) {
      this.samplesPerSecond = Math.round((this.rateSamples * 1000) / (now - this.rateStart));
      this.rateStart = now;
      this.rateSamples = 0;
    }
    this.emit("frame", {
      samples: renderer.samples,
      samplesPerSecond: this.samplesPerSecond,
      converged: max > 0 && renderer.samples >= max,
      width: renderer.width,
      height: renderer.height,
    });
  };

  /** About 10 CSS pixels, measured at the depth of the camera target. */
  private handleRadius(): number {
    const cam = this._scene.camera;
    const { width, height } = this.size;
    return (cam.distance * viewTanHalf(Math.tan((cam.fov * Math.PI) / 360), width / height) * 2 * 10) / height;
  }

  /* ------------------------------------------------------------ pointer */

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 1) {
      for (let i = this.tools.length - 1; i >= 0; i--) {
        if (this.tools[i].down?.(e)) {
          this.activeTool = this.tools[i];
          return;
        }
      }
    }
    if (this.activeTool) return;

    if (e.pointerType === "touch") {
      if (this.pointers.size === 1 && this.lightFollow) {
        this.followPointer(e);
        this.drag = null;
        return;
      }
      if (this.pointers.size === 2) this.startPinch();
      else this.drag = { mode: "orbit", x: e.clientX, y: e.clientY, moved: 0 };
      return;
    }
    const panning = e.button === 1 || e.button === 2 || e.shiftKey;
    this.drag = { mode: panning ? "pan" : "orbit", x: e.clientX, y: e.clientY, moved: 0 };
    this.canvas.style.cursor = "grabbing";
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType !== "mouse") return;
      for (let i = this.tools.length - 1; i >= 0; i--) {
        if (this.tools[i].hover?.(e)) return;
      }
      if (this.lightFollow) this.followPointer(e);
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activeTool) {
      this.activeTool.move?.(e);
      return;
    }
    if (this.pinch && this.pointers.size >= 2) {
      this.updatePinch();
      return;
    }
    if (e.pointerType === "touch" && this.lightFollow && this.pointers.size === 1) {
      this.followPointer(e);
      return;
    }
    const drag = this.drag;
    if (!drag || !this.controls) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (dx === 0 && dy === 0) return;
    const camera = this._scene.camera;
    if (drag.mode === "orbit") {
      const speed = e.pointerType === "touch" ? 0.25 : 0.3;
      orbit(camera, -dx * speed, dy * speed);
    } else {
      const h = this.size.height;
      pan(camera, dx / h, dy / h);
    }
    this.emit("change", { source: "camera" });
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.activeTool) {
      this.activeTool.up?.(e);
      if (this.pointers.size === 0) this.activeTool = null;
      return;
    }
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      if (this.drag && this.drag.moved < 4) {
        this.emit("tap", { clientX: e.clientX, clientY: e.clientY, button: e.button, altKey: e.altKey, shiftKey: e.shiftKey });
      }
      this.drag = null;
      this.canvas.style.cursor = "grab";
    }
  };

  private readonly onPointerLeave = (): void => {
    for (const tool of this.tools) tool.leave?.();
  };

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.drag = null;
  }

  private updatePinch(): void {
    const pinch = this.pinch;
    if (!pinch || !this.controls) return;
    const [a, b] = [...this.pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    const camera = this._scene.camera;
    if (distance > 0 && pinch.distance > 0) zoom(camera, pinch.distance / distance);
    orbit(camera, -(x - pinch.x) * 0.25, (y - pinch.y) * 0.25);
    this.pinch = { distance, x, y };
    this.emit("change", { source: "camera" });
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.controls) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoom(this._scene.camera, Math.exp(clamp(delta, -200, 200) * 0.001));
    this.emit("change", { source: "camera" });
  };

  private readonly onDoubleClick = (): void => {
    if (!this.controls || this.tools.length > 0) return;
    this.resetCamera();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.controls || e.ctrlKey || e.metaKey || e.altKey) return;
    const camera = this._scene.camera;
    const step = 4;
    switch (e.key) {
      case "ArrowLeft": orbit(camera, step, 0); break;
      case "ArrowRight": orbit(camera, -step, 0); break;
      case "ArrowUp": orbit(camera, 0, step); break;
      case "ArrowDown": orbit(camera, 0, -step); break;
      case "+": case "=": zoom(camera, 0.92); break;
      case "-": zoom(camera, 1.08); break;
      case "0": this.resetCamera(); e.preventDefault(); return;
      default: return;
    }
    e.preventDefault();
    this.emit("change", { source: "camera" });
  };

  /**
   * Moves the follow light to the point under the cursor, keeping its height: the light
   * ends up above whatever surface is under the pointer, clamped inside the scene bounds.
   */
  followPointer(e: { clientX: number; clientY: number }): void {
    const scene = this._scene;
    const light = this.lightFollowTarget(scene);
    if (!light || light.type === "sun") return;
    const ray = this.rayAt(e.clientX, e.clientY);
    const hit = raycast(scene, ray, { lights: false });
    let x: number;
    let z: number;
    if (hit) {
      [x, , z] = hit.point;
    } else {
      if (Math.abs(ray.direction[1]) < 1e-6) return;
      const t = (light.position[1] - ray.origin[1]) / ray.direction[1];
      if (t <= 0) return;
      const p = madd(ray.origin, ray.direction, t);
      x = p[0];
      z = p[2];
    }
    const bounds = sceneBounds(scene);
    if (bounds) {
      const margin = light.type === "area" ? Math.max(light.size[0], light.size[1]) / 2 : light.type === "sphere" ? light.radius : 0;
      const fit = (v: number, lo: number, hi: number): number => (hi - lo > 2 * margin ? clamp(v, lo + margin, hi - margin) : v);
      x = fit(x, bounds.min[0], bounds.max[0]);
      z = fit(z, bounds.min[2], bounds.max[2]);
    }
    if (Math.abs(light.position[0] - x) < 1e-4 && Math.abs(light.position[2] - z) < 1e-4) return;
    light.position = [x, light.position[1], z];
    this.emit("change", { source: "light" });
  }
}
