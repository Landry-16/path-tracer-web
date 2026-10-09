import "../lib/auto";
import { MATERIAL_PRESETS } from "../lib/core/presets";

const base = new URL(".", location.href).href;

const script = document.getElementById("snippet-script");
if (script) script.textContent = `<script type="module" src="${base}lib/path-tracer.js"></script>`;

const iframeUrl = `${base}viewer.html?preset=materials&ui=0&follow=1`;
const iframe = document.getElementById("demo-iframe") as HTMLIFrameElement | null;
if (iframe) iframe.src = iframeUrl;
const iframeSnippet = document.getElementById("snippet-iframe");
if (iframeSnippet) {
  iframeSnippet.textContent = `<iframe src="${iframeUrl}"\n  style="width: 100%; aspect-ratio: 16 / 9; border: 0" title="3D scene" loading="lazy"></iframe>`;
}

const swatches = document.getElementById("swatches");
for (const preset of MATERIAL_PRESETS) {
  const figure = document.createElement("figure");
  const preview = document.createElement("pt-material-preview");
  preview.setAttribute("preset", preset.id);
  preview.setAttribute("samples", "64");
  const caption = document.createElement("figcaption");
  caption.textContent = preset.label;
  figure.append(preview, caption);
  swatches?.append(figure);
}

const live = document.querySelector<HTMLElementTagNameMap["pt-material-preview"]>("#live-preview");
const form = document.getElementById("live-form") as HTMLFormElement | null;
function updateLive(): void {
  if (!form || !live) return;
  const data = new FormData(form);
  live.material = {
    baseColor: String(data.get("baseColor")),
    metallic: Number(data.get("metallic")),
    roughness: Number(data.get("roughness")),
    transmission: Number(data.get("transmission")),
    clearcoat: Number(data.get("clearcoat")),
  };
}
form?.addEventListener("input", updateLive);
updateLive();

const log = document.getElementById("event-log");
document.querySelector("pt-editor")?.addEventListener("pt-change", (event) => {
  const { scene } = (event as CustomEvent).detail;
  if (log) {
    log.textContent = `pt-change: "${scene.name}" with ${scene.objects.length} objects, ${scene.lights.length} lights and ${scene.materials.length} materials (${JSON.stringify(scene).length.toLocaleString()} bytes of JSON).`;
  }
});
