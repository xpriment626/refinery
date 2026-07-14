import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  root: "ui",
  plugins: [svelte()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
  },
});
