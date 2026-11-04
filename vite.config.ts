import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = new URL("./src/admin/", import.meta.url).pathname;
const outDir = new URL("./dist/admin/", import.meta.url).pathname;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir,
    emptyOutDir: true,
  },
});
