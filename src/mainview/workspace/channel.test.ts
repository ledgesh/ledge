// The kind map behind the per-workspace default cwd: roots are recorded as
// their handles come through this module (list / create / attach — the one
// place roots enter the view), and only an external root yields a default.
import { afterEach, describe, expect, test } from "bun:test";
import {
  attachWorkspaceFolder,
  configureWorkspaces,
  createWorkspaceFolder,
  dailyWorkspaceRoot,
  listWorkspaceRoots,
  moveWorkspaceFolder,
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

function fakeBridge(attach: AttachResult = attachResult({}), move: AttachResult = attachResult({})) {
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
    move: async (_root, home) =>
      home ? attachResult({ root: "/ws/homed", kind: "managed" }) : move,
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
    await attachWorkspaceFolder();
    expect(workspaceDefaultCwd("/ext/attached")).toBe("/ext/attached");
  });

  test("a cancelled attach records nothing", async () => {
    fakeBridge(attachResult({}));
    await attachWorkspaceFolder();
    expect(workspaceDefaultCwd("/ext/attached")).toBeNull();
  });

  test("boot's direct fetch records through recordWorkspaceKinds", () => {
    recordWorkspaceKinds([{ root: "/ext/boot", kind: "external", available: true }]);
    expect(workspaceDefaultCwd("/ext/boot")).toBe("/ext/boot");
  });

  test("a move re-records the kind under the new handle — the flip is what the default-cwd consumer must see", async () => {
    // A managed folder moved out of the app home becomes external: its notes'
    // shells now anchor to it, where before they had no default.
    fakeBridge(attachResult({}), attachResult({ root: "/synced/managed", kind: "external" }));
    await listWorkspaceRoots(); // records /ws/managed as managed
    await moveWorkspaceFolder("/ws/managed");
    expect(workspaceDefaultCwd("/synced/managed")).toBe("/synced/managed");
    expect(workspaceDefaultCwd("/ws/managed")).toBeNull(); // old handle forgotten
  });

  test("a cancelled move records nothing and forgets nothing", async () => {
    fakeBridge(attachResult({}), attachResult({}));
    await listWorkspaceRoots();
    await moveWorkspaceFolder("/ext/project");
    expect(workspaceDefaultCwd("/ext/project")).toBe("/ext/project");
  });

  test("the home trip flips the kind back to managed, and workspaceKind mirrors it", async () => {
    fakeBridge();
    await listWorkspaceRoots();
    expect(workspaceKind("/ext/project")).toBe("external");
    await moveWorkspaceFolder("/ext/project", true);
    expect(workspaceKind("/ws/homed")).toBe("managed");
    expect(workspaceKind("/ext/project")).toBeNull(); // old handle forgotten
    expect(workspaceDefaultCwd("/ws/homed")).toBeNull(); // managed: no default cwd
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
