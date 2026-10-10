import { mergeConfig } from "vite";
import { resolve } from "node:path";
import view from "./vite.config";

// The harness page, built the way the app's view is: vite.config.ts with a
// different input and output, so the target and the minifier are the shipping
// ones. The e2e suite's `minified` project runs against it (testing.md §5).
// Nothing ships from dist-harness/.
export default mergeConfig(view, {
  build: {
    outDir: "../../dist-harness",
    rollupOptions: { input: resolve(__dirname, "src/mainview/harness.html") },
  },
});
