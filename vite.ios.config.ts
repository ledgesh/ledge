import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The same view, built for the iOS bundle. A second config rather than a
// second input on the first one, because dist/ is copied wholesale into the
// Mac app (electrobun.config.ts) and an ios.html sitting in it would be a dead
// page shipped to every Mac. dist-ios/ is the sibling of dist-cli/ and
// dist-native/: one directory per artifact, none of them each other's.
//
// scripts/ios-build.ts runs this and then copies the result into
// Ledge.app/view/, which the Swift shell serves over its own scheme
// (ios/Sources/BundleScheme.swift).
export default defineConfig({
  plugins: [react()],
  root: "src/mainview",
  base: "./",
  resolve: {
    alias: { "@": resolve(__dirname, "src/mainview") },
  },
  build: {
    outDir: "../../dist-ios",
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/mainview/ios.html") },
  },
});
