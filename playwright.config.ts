// Headless UI tests against the harness build (testing.md §5): the real view in
// a real browser engine, with the Bun process faked at the seams
// (src/mainview/harness.tsx). The engines are the two the app ships in: WebKit
// (the Mac's WKWebView, iOS, WebKitGTK on Linux) and Chromium (Android's
// WebView). Each suite runs in both, so a spec green in one engine only is a
// finding about the other.
//
// Run with `bun run test:e2e`; `--project=webkit` and the like narrow it.
import { defineConfig, devices } from "@playwright/test";

const ci = !!process.env["CI"];

export default defineConfig({
  testDir: "e2e",
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"] }, testIgnore: "phone.spec.ts" },
    // The phone (ios.md §13): the same view at 390x844, with touch instead of a
    // pointer and no keyboard at all. iPhone 14 carries the touch, the coarse
    // pointer and the mobile user agent, and its browser is this suite's
    // WebKit, so what runs here is the shipping engine at the shipping size
    // rather than a resized desktop.
    //
    // The viewport is overridden to the full 390x844, because the descriptor's
    // 664 is what is left after Mobile Safari's chrome and the iOS client is a
    // full-screen WKWebView with none.
    //
    // Only phone.spec.ts runs in this project. The desktop suite asserts
    // desktop affordances, and running it here would report a phone as broken
    // for not having a hover.
    {
      name: "phone",
      use: { ...devices["iPhone 14"], viewport: { width: 390, height: 844 } },
      testMatch: "phone.spec.ts",
    },
    // The desktop suite in Chromium, which is where CodeMirror's editing specs
    // meet the engine Android's WebView is (testing.md §5).
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: "phone.spec.ts" },
    // The phone in Chromium: Pixel 7's touch, coarse pointer and Android user
    // agent, at the `phone` project's 390x844 so the two run the same specs
    // against the same geometry and differ only in the engine.
    {
      name: "android",
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
      testMatch: "phone.spec.ts",
    },
  ],
  // A committed `test.only` silently reduces the suite to one test, and the run
  // still goes green. That is the failure mode CI exists to prevent.
  forbidOnly: ci,
  // One retry, on the runner only. Not to launder flakes: a retried pass is
  // reported as "flaky", which names the problem rather than hiding it, while
  // a single genuine failure still fails the run twice over.
  retries: ci ? 1 : 0,
  // A trace is the only way to debug a failure on a machine nobody can open;
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
