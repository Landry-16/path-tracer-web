/**
 * Script-tag friendly entry: registers the custom elements on import and
 * re-exports the whole API.
 *
 *   <script type="module" src="https://.../lib/path-tracer.js"></script>
 *   <pt-viewer preset="cornell"></pt-viewer>
 */
import { defineElements } from "./elements/elements";

export * from "./index";

defineElements();
