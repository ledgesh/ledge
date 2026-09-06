import { describe, expect, test } from "bun:test";
import {
  isSupportedShell,
  resolveShellArgs,
  resolveShellPath,
  resolveSpawn,
  shellCaveat,
  shellRefusal,
  stampSessionFacts,
  type SpawnDeps,
} from "./spawnParams";
import type { NoteParams } from "../shared/frontmatter";

const HOME = "/home/u";
const PROFILES = "/home/u/.config/ledge/profiles";

// A fake filesystem as two maps: the directories that exist, and the files
// with their text. Warnings are captured so a test can assert that a failure
// warned rather than passing silently.
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
  locked: null,
  hosts: [],
  tags: [],
  template: false,
  confirm: false,
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
    // Passing a missing directory through would make the spawn trampoline
    // _exit(125) on the failed chdir (dist-native/ledge_pty.c, called from
    // pty.ts), so the shell would exit before running anything.
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
    // TERM is pinned back to the base value: xterm.js is the terminal
    // whatever a note claims (architecture.md §6a). A note that exported
    // another TERM would not get a different terminal, it would get a broken
    // one.
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

describe("resolveSpawn: host-terminal identity is scrubbed", () => {
  test("the launching terminal's identity vars do not reach note shells", () => {
    // The app inherits these from the terminal it was launched in, such as
    // the one `bun run dev` ran in, and none of them is true inside a Ledge
    // PTY. CMUX_SURFACE_ID is the one that does visible damage: cmux's
    // `claude` PATH shim reads it and installs session hooks, which then fail
    // in a session cmux does not own.
    const { deps } = fakeFs();
    const base = {
      ...BASE,
      CMUX_SURFACE_ID: "4BFF2BFA",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      GHOSTTY_BIN_DIR: "/Applications/cmux.app/Contents/MacOS",
      TERM_PROGRAM: "WezTerm",
      TERM_PROGRAM_VERSION: "1.0",
      TMUX: "/tmp/tmux-501/default,123,0",
    };
    const r = resolveSpawn(undefined, base, deps, HOME, PROFILES);
    for (const key of Object.keys(base)) {
      if (key in BASE) continue;
      expect(key in r.env).toBe(false);
    }
    // The rest of the base env survives, TERM included (Ledge pins it).
    expect(r.env["TERM"]).toBe("xterm-256color");
    expect(r.env["PATH"]).toBe("/usr/bin");
  });

  test("only the identity vars go: a prefix needs its underscore", () => {
    const { deps } = fakeFs();
    const r = resolveSpawn(undefined, { ...BASE, CMUXY: "mine", KITTYCAT: "also mine" }, deps, HOME, PROFILES);
    expect(r.env["CMUXY"]).toBe("mine");
    expect(r.env["KITTYCAT"]).toBe("also mine");
  });

  test("a note can opt one back in: the scrub is base-layer only", () => {
    // Frontmatter env applies after the scrub, so setting one of these names
    // there puts it back. A note can ask for the outer cmux's socket in order
    // to drive that terminal from a note shell.
    const { deps } = fakeFs();
    const r = resolveSpawn(
      params({ env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" } }),
      { ...BASE, CMUX_SOCKET_PATH: "/inherited/cmux.sock", CMUX_SURFACE_ID: "X" },
      deps,
      HOME,
      PROFILES,
    );
    expect(r.env["CMUX_SOCKET_PATH"]).toBe("/tmp/cmux.sock");
    expect("CMUX_SURFACE_ID" in r.env).toBe(false);
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
    // The parser checks the name too, but only to report a typo. This check
    // guards the RPC path, where a profile name can arrive from the
    // least-trusted end without passing the parser.
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

// Which shell binary, not which argv. resolveShellPath is pure, so the
// `installed` predicate stands in for the machine: a Mac can test what a
// Linux box resolves to, and the other way round.
describe("resolveShellPath", () => {
  const installed = (...paths: string[]) => (p: string) => paths.includes(p);

  test("the account's own login shell wins, because -i sources its rc files", () => {
    // `shell.args` defaults to `-i` (shared/settings.ts), so the shell
    // sources the account's rc files. On a server whose owner configured
    // bash, a zsh would come up with none of their PATH, aliases or
    // functions.
    expect(resolveShellPath("/bin/bash", installed("/bin/bash", "/bin/zsh"))).toBe("/bin/bash");
    expect(resolveShellPath("/bin/zsh", installed("/bin/bash", "/bin/zsh"))).toBe("/bin/zsh");
  });

  test("a login shell Ledge cannot read markers from is passed over, not spawned", () => {
    // dash, which is /bin/sh on Debian, has neither precmd_functions nor
    // PROMPT_COMMAND; the init line's syntax is not valid fish at all. So
    // bun/markers.ts cannot install the hook that ends a block in either.
    // Spawning one would move the silent failure rather than remove it.
    expect(resolveShellPath("/bin/dash", installed("/bin/dash", "/bin/bash"))).toBe("/bin/bash");
    expect(resolveShellPath("/usr/bin/fish", installed("/usr/bin/fish", "/bin/bash"))).toBe("/bin/bash");
  });

  test("a login shell that names nothing on disk is passed over", () => {
    expect(resolveShellPath("/bin/zsh", installed("/bin/bash"))).toBe("/bin/bash");
  });

  test("one fixed fallback order picks each platform's own shell, with no platform test", () => {
    // A Mac always has /bin/zsh and a plain Linux box rarely does, so asking
    // the filesystem answers the platform question on its own.
    expect(resolveShellPath(undefined, installed("/bin/zsh", "/bin/bash"))).toBe("/bin/zsh");
    expect(resolveShellPath(undefined, installed("/bin/bash"))).toBe("/bin/bash");
    expect(resolveShellPath(undefined, installed("/usr/bin/bash"))).toBe("/usr/bin/bash");
  });

  test("a relative $SHELL is not trusted as a path", () => {
    expect(resolveShellPath("zsh", installed("/bin/bash"))).toBe("/bin/bash");
  });

  test("null when nothing supported is installed, so the caller refuses instead of guessing", () => {
    expect(resolveShellPath("/bin/dash", installed("/bin/dash", "/bin/sh"))).toBe(null);
  });
});

describe("shellRefusal and shellCaveat", () => {
  const installed = (...paths: string[]) => (p: string) => paths.includes(p);

  test("a shell that is not there is refused, by name", () => {
    // Without this refusal the fork succeeds and the exec does not, so the
    // block ends with no output, no error and no exit code.
    const why = shellRefusal("/bin/zsh", installed("/bin/bash"));
    expect(why).toContain("/bin/zsh");
    expect(why).toContain("does not exist");
  });

  test("a shell that is there is not refused", () => {
    expect(shellRefusal("/bin/bash", installed("/bin/bash"))).toBe(null);
  });

  test("an empty or relative path is refused before it reaches a fork", () => {
    expect(shellRefusal("", installed("/bin/bash"))).toContain("no shell is configured");
    expect(shellRefusal("bash", installed("/bin/bash"))).toContain("absolute");
  });

  test("an unsupported shell that EXISTS is a caveat, never a refusal", () => {
    // The terminal drawer still works with an unsupported shell. Only inline
    // runs are hurt: they run, but cannot report their output or exit codes.
    // Refusing to spawn it would take the working half away from someone who
    // chose that shell.
    expect(shellRefusal("/usr/bin/fish", installed("/usr/bin/fish"))).toBe(null);
    expect(shellCaveat("/usr/bin/fish")).toContain("inline runs");
    expect(shellCaveat("/bin/zsh")).toBe(null);
    expect(shellCaveat("/bin/bash")).toBe(null);
  });

  test("support is by binary name, so a homebrew or nix path still counts", () => {
    expect(isSupportedShell("/opt/homebrew/bin/bash")).toBe(true);
    expect(isSupportedShell("/nix/store/abc123/bin/zsh")).toBe(true);
    expect(isSupportedShell("/bin/sh")).toBe(false);
  });
});

describe("resolveShellArgs", () => {
  test("a zsh gets comments enabled, after whatever the user configured", () => {
    expect(resolveShellArgs("/bin/zsh", ["-i"])).toEqual(["-i", "-o", "interactive_comments"]);
  });

  test("any other shell is spawned with exactly its configured args", () => {
    // bash enables comments in interactive shells on its own, and
    // `-o interactive_comments` is not a bash set option. Passing it would
    // stop bash from reaching a prompt.
    expect(resolveShellArgs("/bin/bash", ["-i"])).toEqual(["-i"]);
    expect(resolveShellArgs("/opt/homebrew/bin/fish", ["-i"])).toEqual(["-i"]);
  });

  test("args that already name the option win, so zsh's default stays reachable", () => {
    expect(resolveShellArgs("/bin/zsh", ["-i", "+o", "interactive_comments"])).toEqual([
      "-i",
      "+o",
      "interactive_comments",
    ]);
    // zsh option names ignore case and underscores; so does the check.
    expect(resolveShellArgs("/bin/zsh", ["-i", "-o", "INTERACTIVECOMMENTS"])).toEqual([
      "-i",
      "-o",
      "INTERACTIVECOMMENTS",
    ]);
  });

  test("the configured args are not mutated", () => {
    const args = ["-i"];
    resolveShellArgs("/bin/zsh", args);
    expect(args).toEqual(["-i"]);
  });
});

describe("stampSessionFacts", () => {
  const facts = { note: "/ws/plan.md", workspace: "/ws" };

  test("stamps both variables when the session has a note file", () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    stampSessionFacts(env, facts);
    expect(env["LEDGE_NOTE"]).toBe("/ws/plan.md");
    expect(env["LEDGE_WORKSPACE"]).toBe("/ws");
  });

  test("the names are Ledge's: a user layer that set them is overridden", () => {
    // resolveSpawn merges envFile, profile and frontmatter env first.
    // stampSessionFacts runs after them, so a note cannot claim to be a
    // different note: LEDGE_NOTE and LEDGE_WORKSPACE are Ledge's names, never
    // the note's.
    const env: Record<string, string> = { LEDGE_NOTE: "/etc/passwd", LEDGE_WORKSPACE: "/" };
    stampSessionFacts(env, facts);
    expect(env["LEDGE_NOTE"]).toBe("/ws/plan.md");
    expect(env["LEDGE_WORKSPACE"]).toBe("/ws");
  });

  test("no facts scrubs the names — an unsaved note reads as no note, not as its frontmatter's claim", () => {
    const env: Record<string, string> = { LEDGE_NOTE: "/etc/passwd", LEDGE_WORKSPACE: "/" };
    stampSessionFacts(env, null);
    expect("LEDGE_NOTE" in env).toBe(false);
    expect("LEDGE_WORKSPACE" in env).toBe(false);
  });
});
