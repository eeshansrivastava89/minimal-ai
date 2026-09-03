import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@hub": path.resolve(import.meta.dirname, "../hub"),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7700",
    },
  },
});
