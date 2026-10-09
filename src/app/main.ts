import "./style.css";
import { Viewer } from "../lib/viewer/viewer";
import { SCENE_PRESETS, scenePreset } from "../lib/core/presets";

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const ui = {
  stage: element<HTMLElement>("stage"),
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

const viewer = new Viewer(ui.stage, { scene: scenePreset("studio"), lightFollow: true });
viewer.on("error", ({ message }) => {
  ui.error.textContent = message;
  ui.error.hidden = false;
});
viewer.on("frame", (f) => {
  ui.samples.textContent = f.converged ? `${f.samples} (converged)` : String(f.samples);
  ui.speed.textContent = `${f.samplesPerSecond} spp/s`;
  ui.resolution.textContent = `${f.width} x ${f.height}`;
});

for (const preset of SCENE_PRESETS) ui.scene.add(new Option(preset.label, preset.id));
ui.scene.addEventListener("change", () => viewer.setScene(scenePreset(ui.scene.value)));
ui.exposure.addEventListener("input", () => (viewer.scene.render.exposure = Math.log2(Number(ui.exposure.value))));
ui.aperture.addEventListener("input", () => (viewer.scene.camera.aperture = Number(ui.aperture.value)));
ui.quality.addEventListener("change", () => {
  viewer.resolutionScale = Number(ui.quality.value);
  viewer.fit();
});
ui.lock.addEventListener("change", () => (viewer.lightFollow = !ui.lock.checked));
ui.pause.addEventListener("click", () => {
  viewer.paused = !viewer.paused;
  ui.pause.textContent = viewer.paused ? "Resume" : "Pause";
});
ui.save.addEventListener("click", async () => {
  const blob = await viewer.toBlob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `path-tracer-${viewer.samples}spp.png`;
  link.click();
  URL.revokeObjectURL(link.href);
});
