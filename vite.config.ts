import { defineConfig } from "vite";

// Relative base so the build works from any sub-path, including GitHub Pages.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
  },
});
