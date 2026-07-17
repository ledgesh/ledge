import { describe, expect, test } from "bun:test";
import { resolveSpawn, type SpawnDeps } from "./spawnParams";
import type { NoteParams } from "../shared/frontmatter";

const HOME = "/home/u";
const PROFILES = "/home/u/.config/ledge/profiles";

// A filesystem as two maps: dirs that exist, files and their text. Warnings
// are captured so tests can assert the degradation happened out loud.
function fakeFs(opts: { dirs?: string[]; files?: Record<string, string> } = {}) {
  const warns: string[] = [];
  const deps: SpawnDeps = {
    readFile: (path) => opts.files?.[path] ?? null,
    isDir: (path) => opts.dirs?.includes(path) ?? false,
    warn: (msg) => warns.push(msg),
  };
  return { deps, warns };
}

const params = (p: Partial<NoteParams>): NoteParams => ({
  cwd: null,
  profile: null,
  envFile: null,
  env: {},
  ...p,
});

const BASE = { PATH: "/usr/bin", TERM: "xterm-256color", HOME };

describe("resolveSpawn: cwd", () => {
  test("no params at all resolves to exactly the pre-params spawn", () => {
    const { deps, warns } = fakeFs();
    const { cwd, env } = resolveSpawn(undefined, BASE, deps, HOME, PROFILES);
    expect(cwd).toBe(HOME);
    expect(env).toEqual(BASE);
    expect(warns).toEqual([]);
  });

  test("~ expands against home", () => {
    const { deps } = fakeFs({ dirs: ["/home/u/Projects/x"] });
    const r = resolveSpawn(params({ cwd: "~/Projects/x" }), BASE, deps, HOME, PROFILES);
    expect(r.cwd).toBe("/home/u/Projects/x");
  });

  test("a relative cwd resolves against home: notes have no other anchor", () => {
    const { deps } = fakeFs({ dirs: ["/home/u/Projects/x"] });
    const r = resolveSpawn(params({ cwd: "Projects/x" }), BASE, deps, HOME, PROFILES);
    expect(r.cwd).toBe("/home/u/Projects/x");
  });

  test("a missing directory falls back to home, out loud", () => {
    // Passing it through would _exit(125) the child (pty.ts) and the shell
    // would just silently die at birth.
    const { deps, warns } = fakeFs();
    const r = resolveSpawn(params({ cwd: "/gone" }), BASE, deps, HOME, PROFILES);
    expect(r.cwd).toBe(HOME);
    expect(warns.length).toBe(1);
  });
});

describe("resolveSpawn: env layers", () => {
  test("inline env merges over the base", () => {
    const { deps } = fakeFs();
    const r = resolveSpawn(params({ env: { NODE_ENV: "dev" } }), BASE, deps, HOME, PROFILES);
    expect(r.env["NODE_ENV"]).toBe("dev");
    expect(r.env["PATH"]).toBe("/usr/bin");
  });

  test("a profile resolves to <profiles>/<name>.env and merges", () => {
    const { deps, warns } = fakeFs({ files: { [`${PROFILES}/petstore.env`]: "API_KEY=sk-123\n" } });
    const r = resolveSpawn(params({ profile: "petstore" }), BASE, deps, HOME, PROFILES);
    expect(r.env["API_KEY"]).toBe("sk-123");
    expect(warns).toEqual([]);
  });

  test("envFile resolves relative to the note's cwd", () => {
    const { deps } = fakeFs({
      dirs: ["/home/u/proj"],
      files: { "/home/u/proj/.env": "FROM_FILE=yes\n" },
    });
    const r = resolveSpawn(params({ cwd: "~/proj", envFile: "./.env" }), BASE, deps, HOME, PROFILES);
    expect(r.env["FROM_FILE"]).toBe("yes");
  });

  test("precedence: base < envFile < profile < inline env", () => {
    const { deps } = fakeFs({
      dirs: ["/home/u/proj"],
      files: {
        "/home/u/proj/.env": "A=envfile\nB=envfile\nC=envfile\n",
        [`${PROFILES}/p.env`]: "B=profile\nC=profile\n",
      },
    });
    const r = resolveSpawn(
      params({ cwd: "~/proj", envFile: ".env", profile: "p", env: { C: "inline" } }),
      { ...BASE, A: "base", B: "base", C: "base" },
      deps,
      HOME,
      PROFILES,
    );
    expect(r.env["A"]).toBe("envfile");
    expect(r.env["B"]).toBe("profile");
    expect(r.env["C"]).toBe("inline");
  });

  test("TERM is pinned whatever any layer says", () => {
    // A note that exports TERM would not get a different terminal, it would
    // get a broken one: xterm.js is the terminal regardless.
    const { deps } = fakeFs({ files: { [`${PROFILES}/p.env`]: "TERM=dumb\n" } });
    const r = resolveSpawn(params({ profile: "p", env: { TERM: "vt100" } }), BASE, deps, HOME, PROFILES);
    expect(r.env["TERM"]).toBe("xterm-256color");
  });

  test("PATH can be overridden: the venv case", () => {
    const { deps } = fakeFs();
    const r = resolveSpawn(params({ env: { PATH: "/venv/bin:/usr/bin" } }), BASE, deps, HOME, PROFILES);
    expect(r.env["PATH"]).toBe("/venv/bin:/usr/bin");
  });
});

describe("resolveSpawn degrades, never throws", () => {
  test("a missing profile warns and spawns without it", () => {
    const { deps, warns } = fakeFs();
    const r = resolveSpawn(params({ profile: "nope", env: { A: "1" } }), BASE, deps, HOME, PROFILES);
    expect(r.env["A"]).toBe("1"); // the other layers still applied
    expect(warns.length).toBe(1);
  });

  test("a forged profile name is refused at resolution, not just in the parser", () => {
    // The parser's check is a typo message; this one guards the RPC path,
    // where the least-trusted end could send a name the parser never saw.
    const { deps, warns } = fakeFs({ files: { [`${PROFILES}/../evil.env`]: "X=1" } });
    const r = resolveSpawn(params({ profile: "../evil" }), BASE, deps, HOME, PROFILES);
    expect(r.env["X"]).toBeUndefined();
    expect(warns.length).toBe(1);
  });

  test("forged env entries are dropped one by one", () => {
    const forged = { "BAD NAME": "x", OK: "1" } as Record<string, string>;
    const { deps, warns } = fakeFs();
    const r = resolveSpawn(params({ env: forged }), BASE, deps, HOME, PROFILES);
    expect(r.env["OK"]).toBe("1");
    expect(r.env["BAD NAME"]).toBeUndefined();
    expect(warns.length).toBe(1);
  });

  test("a missing envFile warns and spawns without it", () => {
    const { deps, warns } = fakeFs();
    const r = resolveSpawn(params({ envFile: "./.env" }), BASE, deps, HOME, PROFILES);
    expect(r.cwd).toBe(HOME);
    expect(warns.length).toBe(1);
  });

  test("a profile file's bad lines warn per line and cost only themselves", () => {
    const { deps, warns } = fakeFs({ files: { [`${PROFILES}/p.env`]: "junk line\nGOOD=1\n" } });
    const r = resolveSpawn(params({ profile: "p" }), BASE, deps, HOME, PROFILES);
    expect(r.env["GOOD"]).toBe("1");
    expect(warns.length).toBe(1);
  });
});
