// Headless UI tests against the harness build (testing.md §5): the real
// view in a real WebKit — the same engine lineage as the WKWebView the app
// ships in, which is what makes focus/tabindex behavior representative — with
// the Bun process faked at the seams (src/mainview/harness.tsx).
//
// Run with `bun run test:e2e`. WebKit only, deliberately: this suite exists to
// catch WebKit behavior, and a Chromium pass would only ever green-light what
// the shipping engine then does differently.
import { defineConfig, devices } from "@playwright/test";

const ci = !!process.env["CI"];

export default defineConfig({
  testDir: "e2e",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  // A committed `test.only` silently reduces the suite to one test, and the
  // run still goes green — the failure mode CI exists to prevent.
  forbidOnly: ci,
  // One retry, on the runner only. Not to launder flakes: a retried pass is
  // reported as "flaky", which names the problem rather than hiding it, while
  // a single genuine failure still fails the run twice over.
  retries: ci ? 1 : 0,
  // A trace is the only way to debug a failure on a machine you cannot see;
  // on-first-retry keeps the cost off the passing run.
  use: { baseURL: "http://localhost:5199", trace: ci ? "on-first-retry" : "off" },
  // `github` annotates the failing lines in the PR diff; `html` is what the
  // workflow uploads when the run goes red.
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  webServer: {
    command: "bunx vite --port 5199",
    url: "http://localhost:5199/harness.html",
    reuseExistingServer: true,
  },
});
