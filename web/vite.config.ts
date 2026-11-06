import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Relative paths, so the build also works from a sub-folder or a plain static host.
  base: "./",
  build: { chunkSizeWarningLimit: 1800 },
  test: { include: ["src/**/*.test.ts"] },
});
