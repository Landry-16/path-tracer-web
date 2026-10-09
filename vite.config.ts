import { defineConfig } from "vite";
import { resolve } from "node:path";

// Site build: the editor (index), the iframe viewer and the embedding guide.
// Relative base so the build works from any sub-path, including GitHub Pages.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        editor: resolve(__dirname, "index.html"),
        viewer: resolve(__dirname, "viewer.html"),
      },
    },
  },
});
