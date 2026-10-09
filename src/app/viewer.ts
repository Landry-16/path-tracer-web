/**
 * Stand-alone viewer page, designed to be embedded with an iframe.
 *
 * Scene sources, in order: #s=<share payload>, ?src=<url of a scene JSON>, ?preset=<id>.
 * Options: ?controls=0 disables camera controls, ?follow=1 makes the light follow the
 * pointer, ?ui=0 hides the sample counter and editor link, ?samples=N caps the samples.
 *
 * postMessage API (from the parent page):
 *   { type: "pt:set-scene", scene }   replaces the scene
 *   { type: "pt:snapshot" }           replies { type: "pt:snapshot", blob }
 * The page posts { type: "pt:ready" } to its parent once loaded.
 */
import { Viewer } from "../lib/viewer/viewer";
import { normalizeScene } from "../lib/core/scene";
import { encodeScene, sceneFromHash } from "../lib/core/share";
import { scenePreset } from "../lib/core/presets";

const params = new URLSearchParams(location.search);
const flag = (name: string, fallback: boolean): boolean => {
  const v = params.get(name);
  return v === null ? fallback : v !== "0" && v !== "false";
};

const host = document.getElementById("view") as HTMLElement;
const chrome = document.getElementById("chrome") as HTMLElement;
const samples = document.getElementById("samples") as HTMLElement;
const open = document.getElementById("open") as HTMLAnchorElement;

const viewer = new Viewer(host, { controls: flag("controls", true), lightFollow: flag("follow", false) });
chrome.hidden = !flag("ui", true);

viewer.on("frame", (f) => {
  samples.textContent = `${f.samples} spp`;
});
viewer.on("error", ({ message }) => {
  samples.textContent = message;
});

async function load(): Promise<void> {
  let scene = await sceneFromHash(location.hash);
  const src = params.get("src");
  if (!scene && src) {
    try {
      const response = await fetch(src);
      if (response.ok) scene = normalizeScene(await response.json());
    } catch {
      samples.textContent = `Could not load ${src}`;
    }
  }
  scene ??= scenePreset(params.get("preset") ?? "studio");
  const max = Number(params.get("samples"));
  if (max > 0) scene.render.maxSamples = Math.round(max);
  viewer.setScene(scene);
  open.href = `./#s=${await encodeScene(scene)}`;
  window.parent?.postMessage({ type: "pt:ready" }, "*");
}

window.addEventListener("message", async (event: MessageEvent) => {
  const data = event.data as { type?: string; scene?: unknown } | null;
  if (!data || typeof data !== "object") return;
  if (data.type === "pt:set-scene" && data.scene) {
    viewer.setScene(normalizeScene(data.scene));
  } else if (data.type === "pt:snapshot") {
    const blob = await viewer.toBlob();
    (event.source as Window | null)?.postMessage({ type: "pt:snapshot", blob }, { targetOrigin: event.origin === "null" ? "*" : event.origin });
  }
});

void load();
