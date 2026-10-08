import "./style.css";
import { OrbitCamera } from "./camera";
import { Controls } from "./controls";
import { GLError } from "./gl";
import { Renderer } from "./renderer";
import { SCENES, cloneScene, type Scene } from "./scene";

/** Stops refining once the image is visually converged. */
const MAX_SAMPLES = 4096;

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const canvas = element<HTMLCanvasElement>("view");
const ui = {
  error: element<HTMLParagraphElement>("error"),
  samples: element<HTMLElement>("samples"),
  speed: element<HTMLElement>("speed"),
  resolution: element<HTMLElement>("resolution"),
  scene: element<HTMLSelectElement>("scene"),
  exposure: element<HTMLInputElement>("exposure"),
  aperture: element<HTMLInputElement>("aperture"),
  quality: element<HTMLSelectElement>("quality"),
  lock: element<HTMLInputElement>("lock"),
  pause: element<HTMLButtonElement>("pause"),
  save: element<HTMLButtonElement>("save"),
};

function showError(message: string): void {
  ui.error.textContent = message;
  ui.error.hidden = false;
}

function start(): void {
  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    showError(err instanceof GLError ? err.message : `Unexpected error: ${String(err)}`);
    return;
  }

  const camera = new OrbitCamera();
  let scene: Scene = cloneScene(SCENES[0]);
  let paused = false;
  const restart = (): void => renderer.reset();

  const controls = new Controls({ canvas, camera, getScene: () => scene, onChange: restart });

  for (const preset of SCENES) ui.scene.add(new Option(preset.label, preset.id));
  ui.scene.addEventListener("change", () => {
    const preset = SCENES.find((s) => s.id === ui.scene.value) ?? SCENES[0];
    scene = cloneScene(preset);
    restart();
  });
  ui.exposure.addEventListener("input", () => {
    renderer.exposure = Number(ui.exposure.value);
    if (paused || renderer.samples >= MAX_SAMPLES) renderer.render(scene, camera);
  });
  ui.aperture.addEventListener("input", () => {
    camera.aperture = Number(ui.aperture.value);
    restart();
  });
  ui.quality.addEventListener("change", () => {
    renderer.resolutionScale = Number(ui.quality.value);
    fit();
  });
  ui.lock.addEventListener("change", () => {
    controls.lightLocked = ui.lock.checked;
  });
  ui.pause.addEventListener("click", () => {
    paused = !paused;
    ui.pause.textContent = paused ? "Resume" : "Pause";
  });
  ui.save.addEventListener("click", () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `path-tracer-${scene.id}-${renderer.samples}spp.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === " " && e.target === canvas) {
      e.preventDefault();
      ui.pause.click();
    }
  });

  function fit(): void {
    renderer.resize(canvas.clientWidth, canvas.clientHeight, Math.min(window.devicePixelRatio || 1, 2));
    ui.resolution.textContent = `${renderer.width} x ${renderer.height}`;
  }
  new ResizeObserver(fit).observe(canvas);
  fit();

  let windowStart = performance.now();
  let windowSamples = 0;

  function frame(now: number): void {
    requestAnimationFrame(frame);
    if (paused || document.hidden || renderer.samples >= MAX_SAMPLES) return;
    renderer.render(scene, camera);
    windowSamples++;
    ui.samples.textContent = renderer.samples >= MAX_SAMPLES ? `${MAX_SAMPLES} (converged)` : String(renderer.samples);
    if (now - windowStart > 500) {
      ui.speed.textContent = `${Math.round((windowSamples * 1000) / (now - windowStart))} spp/s`;
      windowStart = now;
      windowSamples = 0;
    }
  }
  requestAnimationFrame(frame);
}

start();
