// The kind map behind the per-workspace default cwd: this module is the one
// place roots enter the view, so it records a root's kind as the handle
// passes through listWorkspaceRoots, createWorkspaceFolder,
// attachWorkspaceFolder. boot.tsx and the harness
// fetch the registry directly and record with recordWorkspaceKinds. Only an
// external root yields a default cwd.
import { afterEach, describe, expect, test } from "bun:test";
import {
  attachWorkspaceFolder,
  configureWorkspaces,
  createWorkspaceFolder,
  dailyWorkspaceRoot,
  listWorkspaceRoots,
  recordDailyRoot,
  recordWorkspaceKinds,
  resetWorkspaceKinds,
  workspaceDefaultCwd,
  workspaceKind,
  type AttachResult,
} from "./channel";

const attachResult = (res: Partial<AttachResult>): AttachResult => ({
  root: null,
  kind: null,
  error: null,
  ...res,
});

function fakeBridge(attach: AttachResult = attachResult({})) {
  configureWorkspaces({
    list: async () => ({
      workspaces: [
        { root: "/ws/managed", kind: "managed", available: true },
        { root: "/ext/project", kind: "external", available: true },
      ],
      dailyRoot: "/ws/managed",
    }),
    create: async () => "/ws/created",
    attach: async () => attach,
    detach: async () => true,
    pickFolder: async () => null,
  });
}

afterEach(() => {
  resetWorkspaceKinds();
});

describe("workspaceDefaultCwd", () => {
  test("only an external root anchors a default; managed and unknown do not", async () => {
    fakeBridge();
    await listWorkspaceRoots();
    expect(workspaceDefaultCwd("/ext/project")).toBe("/ext/project");
    expect(workspaceDefaultCwd("/ws/managed")).toBeNull();
    expect(workspaceDefaultCwd("/never/seen")).toBeNull();
  });

  test("a created folder is managed: no default", async () => {
    fakeBridge();
    await createWorkspaceFolder("Scratch");
    expect(workspaceDefaultCwd("/ws/created")).toBeNull();
  });

  test("an attached folder carries the kind the attach reported", async () => {
    fakeBridge(attachResult({ root: "/ext/attached", kind: "external" }));
    await attachWorkspaceFolder("/ext/attached");
    expect(workspaceDefaultCwd("/ext/attached")).toBe("/ext/attached");
  });

  test("a refused attach records nothing", async () => {
    fakeBridge(attachResult({ error: "not a directory: /ext/attached" }));
    await attachWorkspaceFolder("/ext/attached");
    expect(workspaceDefaultCwd("/ext/attached")).toBeNull();
  });

  test("boot's direct fetch records through recordWorkspaceKinds", () => {
    recordWorkspaceKinds([{ root: "/ext/boot", kind: "external", available: true }]);
    expect(workspaceDefaultCwd("/ext/boot")).toBe("/ext/boot");
  });

});

describe("dailyWorkspaceRoot", () => {
  test("null until recorded; list() records what Bun resolved", async () => {
    expect(dailyWorkspaceRoot()).toBeNull();
    fakeBridge();
    await listWorkspaceRoots();
    expect(dailyWorkspaceRoot()).toBe("/ws/managed");
  });

  test("boot's direct fetch records through recordDailyRoot, null included", () => {
    recordDailyRoot("/ws/managed");
    expect(dailyWorkspaceRoot()).toBe("/ws/managed");
    recordDailyRoot(null);
    expect(dailyWorkspaceRoot()).toBeNull();
  });
});
