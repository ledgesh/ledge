import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The same view, built for the Android app, for vite.ios.config.ts's reason:
// dist/ ships wholesale in the Mac app. The Gradle build packages dist-android/
// as the APK's assets (android/app/build.gradle.kts), which the Kotlin shell
// serves over WebViewAssetLoader.
export default defineConfig({
  plugins: [react()],
  root: "src/mainview",
  base: "./",
  resolve: {
    alias: { "@": resolve(__dirname, "src/mainview") },
  },
  build: {
    outDir: "../../dist-android",
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/mainview/android.html") },
  },
});
