import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["server/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  skipNodeModulesBundle: true,
});
