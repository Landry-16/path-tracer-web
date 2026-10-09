import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Library builds (run twice, see package.json):
 *   --mode index  dist-lib/index.js        side-effect free ES module for bundlers (npm)
 *   --mode auto   dist-lib/path-tracer.js  minified, registers <pt-*> elements on import (script tag / CDN)
 */
export default defineConfig(({ mode }) => {
  const auto = mode === "auto";
  return {
    publicDir: false,
    build: {
      outDir: "dist-lib",
      emptyOutDir: !auto,
      target: "es2022",
      sourcemap: true,
      minify: auto ? "esbuild" : false,
      lib: {
        entry: resolve(__dirname, auto ? "src/lib/auto.ts" : "src/lib/index.ts"),
        formats: ["es"],
        fileName: () => (auto ? "path-tracer.js" : "index.js"),
      },
    },
  };
});
