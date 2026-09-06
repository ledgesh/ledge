import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BUN_FLOOR,
  dockerPlatform,
  ELF_MACHINE,
  elfMachine,
  manifest,
  missingTargets,
  NATIVE_TARGETS,
  nativePath,
  PACKAGE_NAME,
  routeFor,
} from "./npmPackage";
import { NATIVE_DIR, NATIVE_LIB } from "./ptyNative";

const ROOT = resolve(import.meta.dir, "..", "..");

describe("the published manifest", () => {
  // The manifest must not carry `private`. The root package.json does, and
  // npm refuses to publish a private package. The refusal comes at the end of
  // a release rather than the start of one.
  test("is publishable", () => {
    const m = manifest("1.2.3") as unknown as Record<string, unknown>;
    expect(m["private"]).toBeUndefined();
    expect(m["name"]).toBe(PACKAGE_NAME);
    expect(m["version"]).toBe("1.2.3");
  });

  test("installs one command, and it is the package's own name", () => {
    expect(manifest("0.0.0").bin).toEqual({ [PACKAGE_NAME]: "bin/ledge-server.js" });
  });

  // npm enforces os and cpu at install time, so those two fields state where
  // the package runs. The assertion derives from NATIVE_TARGETS: a target
  // added without widening these ships a tarball npm refuses to install on
  // the machine it was added for.
  test("names exactly the platforms and architectures it carries", () => {
    const m = manifest("0.0.0");
    expect(new Set(m.os)).toEqual(new Set(NATIVE_TARGETS.map((t) => t.platform)));
    expect(new Set(m.cpu)).toEqual(new Set(NATIVE_TARGETS.map((t) => t.arch)));
  });

  test("states the Bun floor, since npm cannot enforce it", () => {
    expect(manifest("0.0.0").engines).toEqual({ bun: BUN_FLOOR });
  });

  // The manifest's `bin` field points at bin/ledge-server.js inside the
  // package, and scripts/build-npm.ts copies this repo file there. A rename
  // that misses one of the two publishes a package whose only command is a
  // dangling bin link.
  test("the bin it points at is a file in the repo", () => {
    expect(existsSync(join(ROOT, "npm", "bin", "ledge-server.js"))).toBe(true);
  });

  test("the bin refuses a runtime that is not Bun before importing the bundle", () => {
    const src = readFileSync(join(ROOT, "npm", "bin", "ledge-server.js"), "utf8");
    const guard = src.indexOf(`typeof Bun === "undefined"`);
    const load = src.indexOf("../lib/serve.js");
    expect(guard).toBeGreaterThan(-1);
    // The guard has to come first, and the bin has to reach the bundle
    // through `await import`. The bundle statically imports bun:ffi, an
    // unresolvable specifier under any other runtime. A static import runs
    // before the guard whatever its position, so it would fail there and the
    // guard's message would never print.
    expect(load).toBeGreaterThan(guard);
    expect(src).toContain("await import(");
  });
});

describe("the native layout", () => {
  // The drift invariant: scripts/build-npm.ts writes these directories and
  // bun/pty.ts reads them. A disagreement is not a crash. The server falls
  // through to the in-process compile. That compile fails for want of headers
  // on a machine that installed rather than built. Every shell then runs with
  // no controlling terminal, Ctrl-C stops working, and nothing says why.
  test("is the one pty.ts computes for this machine", () => {
    const here = NATIVE_TARGETS.find((t) => t.platform === process.platform && t.arch === process.arch);
    expect(here).toBeDefined();
    expect(nativePath(here!)).toBe(`lib/native/${NATIVE_DIR}/${NATIVE_LIB}`);
  });

  test("gives each target its own directory and the right extension", () => {
    expect(nativePath({ platform: "darwin", arch: "arm64" })).toBe("lib/native/darwin-arm64/libledge_pty.dylib");
    expect(nativePath({ platform: "linux", arch: "x64" })).toBe("lib/native/linux-x64/libledge_pty.so");
  });

  test("covers both architectures on both platforms", () => {
    expect(NATIVE_TARGETS.length).toBe(4);
    expect(new Set(NATIVE_TARGETS.map((t) => nativePath(t))).size).toBe(4);
  });
});

describe("missingTargets", () => {
  test("an empty tree is missing all of them", () => {
    expect(missingTargets([])).toEqual([...NATIVE_TARGETS]);
  });

  test("a complete tree is missing none", () => {
    expect(missingTargets(NATIVE_TARGETS.map((t) => nativePath(t)))).toEqual([]);
  });

  test("names the one that is absent", () => {
    const all = NATIVE_TARGETS.map((t) => nativePath(t));
    const without = all.filter((p) => !p.includes("linux-arm64"));
    expect(missingTargets(without)).toEqual([{ platform: "linux", arch: "arm64" }]);
  });

  // missingTargets compares whole paths, not substrings, so a nearly right
  // path leaves its target uncovered. A refactor produces exactly this shape:
  // a Mach-O extension inside a linux directory.
  test("a file in the wrong place does not count", () => {
    expect(missingTargets(["lib/native/linux-arm64/libledge_pty.dylib"]).length).toBe(NATIVE_TARGETS.length);
  });
});

describe("routeFor", () => {
  test("the Mach-O slices need a Mac", () => {
    expect(routeFor({ platform: "darwin", arch: "arm64" }, "darwin")).toBe("universal-dylib");
    expect(routeFor({ platform: "darwin", arch: "x64" }, "darwin")).toBe("universal-dylib");
  });

  // A complete package can only be assembled on a Mac. No other host can
  // produce a Mach-O slice at all, so routeFor has no route to offer and
  // answers "unavailable". A test pins the rule because the release runbook
  // has to obey it (docs/contributor/releasing.md §6).
  test("and cannot be built anywhere else", () => {
    expect(routeFor({ platform: "darwin", arch: "arm64" }, "linux")).toBe("unavailable");
    expect(routeFor({ platform: "darwin", arch: "arm64" }, "win32")).toBe("unavailable");
  });

  test("the ELF ones always come from a container, whatever the host", () => {
    for (const host of ["darwin", "linux"]) {
      expect(routeFor({ platform: "linux", arch: "x64" }, host)).toBe("docker");
      expect(routeFor({ platform: "linux", arch: "arm64" }, host)).toBe("docker");
    }
  });

  test("docker spells x64 amd64", () => {
    expect(dockerPlatform({ platform: "linux", arch: "x64" })).toBe("linux/amd64");
    expect(dockerPlatform({ platform: "linux", arch: "arm64" })).toBe("linux/arm64");
  });
});

describe("elfMachine", () => {
  function header(machine: number, { big = false }: { big?: boolean } = {}): Uint8Array {
    const b = new Uint8Array(20);
    b.set([0x7f, 0x45, 0x4c, 0x46], 0);
    b[5] = big ? 2 : 1;
    if (big) {
      b[0x12] = (machine >> 8) & 0xff;
      b[0x13] = machine & 0xff;
    } else {
      b[0x12] = machine & 0xff;
      b[0x13] = (machine >> 8) & 0xff;
    }
    return b;
  }

  test("reads the architecture the psABI numbers", () => {
    expect(elfMachine(header(0x3e))).toBe(ELF_MACHINE["x64"]);
    expect(elfMachine(header(0xb7))).toBe(ELF_MACHINE["arm64"]);
  });

  // scripts/build-npm.ts calls elfMachine to catch a docker build that
  // answered --platform with the host's architecture, so the two numbers have
  // to come out different.
  test("tells x86-64 and AArch64 apart", () => {
    expect(elfMachine(header(0x3e))).not.toBe(elfMachine(header(0xb7)));
  });

  test("honours the endianness the header declares", () => {
    expect(elfMachine(header(0xb7, { big: true }))).toBe(0xb7);
  });

  test("a Mach-O is not an ELF", () => {
    // These bytes are Mach-O magic. They land here when a darwin slice is
    // copied into a linux directory.
    expect(elfMachine(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  test("a truncated read is not an architecture", () => {
    expect(elfMachine(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBeNull();
  });
});
