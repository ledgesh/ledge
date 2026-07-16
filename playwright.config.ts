// Headless UI tests against the harness build (docs/testing.md §5): the real
// view in a real WebKit — the same engine lineage as the WKWebView the app
// ships in, which is what makes focus/tabindex behavior representative — with
// the Bun process faked at the seams (src/mainview/harness.tsx).
//
// Run with `bun run test:e2e`. WebKit only, deliberately: this suite exists to
// catch WebKit behavior, and a Chromium pass would only ever green-light what
// the shipping engine then does differently.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  use: { baseURL: "http://localhost:5199" },
  webServer: {
    command: "bunx vite --port 5199",
    url: "http://localhost:5199/harness.html",
    reuseExistingServer: true,
  },
});
