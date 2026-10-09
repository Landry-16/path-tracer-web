// Publishes the script-tag bundle next to the site so other pages can load it from the deployment:
//   <script type="module" src="https://<user>.github.io/path-tracer-web/lib/path-tracer.js"></script>
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/lib", { recursive: true });
for (const file of ["path-tracer.js", "path-tracer.js.map", "index.js", "index.js.map"]) {
  cpSync(`dist-lib/${file}`, `dist/lib/${file}`);
}
cpSync("dist-lib/types", "dist/lib/types", { recursive: true });
console.log("Copied the library bundles to dist/lib");
