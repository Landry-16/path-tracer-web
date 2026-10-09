/**
 * Material previews ("material balls") rendered with the path tracer.
 *
 * All previews on a page share one hidden WebGL context and a job queue, so a
 * material library with dozens of thumbnails never runs into the browser's limit
 * on live WebGL contexts. Each job refines progressively and is copied into the
 * caller's 2D canvas as it converges.
 */

import { createLight, createMaterial, createObject, normalizeMaterial, normalizeScene, type Material, type Scene, type ShapeType } from "../core/scene";
import { Renderer } from "../render/renderer";

export interface PreviewOptions {
  /** Samples per pixel of the finished preview. Default 64. */
  samples?: number;
  /** Shape carrying the material. Default "sphere". */
  shape?: ShapeType;
  /** Backdrop: a checker floor under a soft studio light, or plain dark. Default "studio". */
  background?: "studio" | "dark";
}

interface Job {
  target: HTMLCanvasElement;
  scene: Scene;
  samples: number;
  resolve: () => void;
  cancelled: boolean;
}

function previewScene(material: Material, shape: ShapeType, background: "studio" | "dark"): Scene {
  const floor = createMaterial({
    id: "preview-floor",
    name: "Floor",
    baseColor: background === "dark" ? "#202020" : "#bdbdbd",
    roughness: 0.9,
    pattern: "checker",
    patternColor: background === "dark" ? "#141414" : "#8a8a8a",
    patternScale: 4,
  });
  const subject = { ...material, id: "preview-subject" };
  return normalizeScene({
    name: "Preview",
    camera: { target: [0, 0.5, 0], yaw: 0, pitch: 14, distance: 2.35, fov: 32 },
    environment: background === "dark" ? { type: "color", color: "#0b0b0b", intensity: 1 } : { type: "sky", zenith: "#6b7380", horizon: "#d9dce0", ground: "#3a3a3a", intensity: 0.6 },
    render: { maxBounces: 6, maxSamples: 0, exposure: 0, toneMapping: "aces", clamp: 10 },
    materials: [floor, subject],
    objects: [
      createObject("plane", { position: [0, 0, 0], scale: [6, 1, 6], materialId: floor.id }),
      createObject(shape, {
        position: [0, 0.5, 0],
        rotation: shape === "plane" || shape === "disk" ? [65, 0, 0] : shape === "box" ? [0, 35, 0] : [0, 0, 0],
        scale: shape === "plane" || shape === "disk" ? [0.95, 1, 0.95] : [0.9, 0.9, 0.9],
        materialId: subject.id,
      }),
    ],
    lights: [
      createLight("area", { position: [-1.1, 2, 1.1], rotation: [-30, 0, -30], size: [1.4, 1.4], intensity: 5 }),
      createLight("area", { position: [1.6, 1.2, -0.6], rotation: [0, 0, 70], size: [0.6, 1.4], intensity: 2.5, color: "#dfe8ff", visible: false }),
    ],
  });
}

class PreviewQueue {
  private canvas: HTMLCanvasElement | null = null;
  private renderer: Renderer | null = null;
  private failed = false;
  private readonly jobs: Job[] = [];
  private current: Job | null = null;
  private handle = 0;

  enqueue(target: HTMLCanvasElement, scene: Scene, samples: number): Promise<void> {
    // A newer request for the same canvas replaces the pending one.
    for (const job of this.jobs) {
      if (job.target === target) {
        job.cancelled = true;
        job.resolve();
      }
    }
    if (this.current?.target === target) this.current.cancelled = true;
    return new Promise((resolve) => {
      this.jobs.push({ target, scene, samples, resolve, cancelled: false });
      if (!this.handle) this.handle = requestAnimationFrame(this.tick);
    });
  }

  private ensureRenderer(): Renderer | null {
    if (this.renderer || this.failed) return this.renderer;
    try {
      this.canvas = document.createElement("canvas");
      this.renderer = new Renderer(this.canvas);
    } catch {
      this.failed = true;
    }
    return this.renderer;
  }

  private readonly tick = (): void => {
    this.handle = 0;
    const renderer = this.ensureRenderer();
    if (!renderer) {
      this.jobs.splice(0).forEach((j) => j.resolve());
      return;
    }
    const start = performance.now();
    // Spend at most ~10 ms per frame so the rest of the page stays smooth.
    while (performance.now() - start < 10) {
      let job = this.current;
      if (!job || job.cancelled) {
        job = this.current = this.jobs.shift() ?? null;
        if (!job) break;
        if (job.cancelled) continue;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(16, Math.round((job.target.clientWidth || job.target.width) * ratio));
        const h = Math.max(16, Math.round((job.target.clientHeight || job.target.height) * ratio));
        renderer.resize(w, h);
        renderer.sync(job.scene);
        renderer.reset();
        if (job.target.width !== w) job.target.width = w;
        if (job.target.height !== h) job.target.height = h;
      }
      renderer.render(1);
      const done = renderer.samples >= job.samples;
      if (done || renderer.samples % 8 === 0 || renderer.samples === 2) this.blit(job);
      if (done) {
        job.resolve();
        this.current = null;
      }
    }
    if (this.current || this.jobs.length > 0) this.handle = requestAnimationFrame(this.tick);
  };

  private blit(job: Job): void {
    const ctx = job.target.getContext("2d");
    if (!ctx || !this.canvas) return;
    ctx.drawImage(this.canvas, 0, 0, job.target.width, job.target.height);
  }
}

let queue: PreviewQueue | null = null;

/**
 * Renders a material ball into `target` (a regular 2D canvas, sized with CSS or its width/height).
 * Resolves once the preview reached the requested number of samples.
 */
export function renderMaterialPreview(
  material: Partial<Material>,
  target: HTMLCanvasElement,
  options: PreviewOptions = {},
): Promise<void> {
  queue ??= new PreviewQueue();
  const scene = previewScene(normalizeMaterial(material), options.shape ?? "sphere", options.background ?? "studio");
  return queue.enqueue(target, scene, options.samples ?? 64);
}
