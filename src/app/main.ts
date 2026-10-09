import { Editor } from "../lib/editor/editor";
import { sceneFromHash } from "../lib/core/share";
import { scenePreset } from "../lib/core/presets";

const STORAGE_KEY = "path-tracer-web:scene";
const root = document.getElementById("app");
if (!root) throw new Error("Missing #app");

const editor = new Editor(root, { storageKey: STORAGE_KEY, baseUrl: new URL(".", location.href).href });

async function loadFromUrl(): Promise<void> {
  const shared = await sceneFromHash(location.hash);
  if (shared) {
    editor.setScene(shared);
  } else {
    const preset = new URLSearchParams(location.search).get("preset");
    if (preset) editor.setScene(scenePreset(preset));
  }
  if (shared) history.replaceState(null, "", location.pathname + location.search);
}

void loadFromUrl();
window.addEventListener("hashchange", () => void loadFromUrl());

// Handy for debugging and for automation from the console.
Object.assign(window, { editor });
