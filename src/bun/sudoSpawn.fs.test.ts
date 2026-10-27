// sudoArgs and the remote preamble against a real /bin/sh and a fake sudo in
// a scratch directory, so the quoting is proven by a shell parsing it rather
// than by reading the string.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sudoArgs } from "./sudoSpawn";
import { buildRemoteSpawn } from "./remoteSpawn";
import type { NoteParams } from "../shared/frontmatter";

const NONCE = "n0nce";
const quiet = () => {};
let DIR = "";
// Runs its command the way sudo does once it has let it through: drops
// `-u <user> --` and execs the rest.
let RUN = "";
// Prints the argv it was given, one argument per line, and runs nothing.
let ECHO = "";

beforeAll(() => {
  DIR = mkdtempSync(join(tmpdir(), "ledge-sudo-"));
  RUN = join(DIR, "run");
  writeFileSync(RUN, '#!/bin/sh\n[ "$1" = -u ] && shift 2\n[ "$1" = -- ] && shift\nexec "$@"\n');
  chmodSync(RUN, 0o755);
  const bin = join(DIR, "bin");
  mkdirSync(bin);
  ECHO = join(bin, "sudo");
  writeFileSync(ECHO, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  chmodSync(ECHO, 0o755);
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const params = (p: Partial<NoteParams>): NoteParams => ({
  cwd: null,
  profile: null,
  envFile: null,
  env: {},
  hosts: ["web1"],
  sudo: "root",
  tags: [],
  template: false,
  confirm: false,
  favorite: false,
  archived: false,
  locked: null,
  ...p,
});

describe("sudoArgs", () => {
  test("names the user, ends sudo's options, and hands the rest to /bin/sh", () => {
    const args = sudoArgs("postgres", {}, "'/bin/zsh' '-i'", null, quiet);
    expect(args.slice(0, 5)).toEqual(["-u", "postgres", "--", "/bin/sh", "-c"]);
    expect(args[5]).toBe("exec '/bin/zsh' '-i'");
  });

  test("the exported values reach the shell exactly, whatever they hold", () => {
    const env = { A: "plain", B: "it's $HOME and `id`", C: "a b;c" };
    const out = Bun.spawnSync([RUN, ...sudoArgs("root", env, "env", null, quiet)], { env: {} }).stdout.toString();
    expect(out).toContain("A=plain\n");
    expect(out).toContain("B=it's $HOME and `id`\n");
    expect(out).toContain("C=a b;c\n");
  });

  test("an inline shell prints the up marker before it execs", () => {
    const out = Bun.spawnSync([RUN, ...sudoArgs("root", {}, "echo shell", NONCE, quiet)]).stdout.toString();
    expect(out).toBe(`\x1b]133;U;ledge=${NONCE}\x07shell\n`);
  });

  test("a bad env name warns and is dropped", () => {
    const warns: string[] = [];
    const args = sudoArgs("root", { "BAD NAME": "x", OK: "1" }, "env", null, (m) => warns.push(m));
    expect(args[5]).not.toContain("BAD NAME");
    expect(warns.length).toBe(1);
  });

  test("a user that is not a user name throws: degrading would run as someone else", () => {
    expect(() => sudoArgs("-s", {}, "env", null, quiet)).toThrow();
    expect(() => sudoArgs("root;id", {}, "env", null, quiet)).toThrow();
    expect(() => sudoArgs(0 as unknown as string, {}, "env", null, quiet)).toThrow();
  });
});

describe("buildRemoteSpawn with sudo", () => {
  // The preamble is what the remote login shell parses. Run it here with the
  // printing sudo first on PATH, and sudo must receive sudoArgs' argv intact.
  const sudoArgvOf = (preamble: string): string[] => {
    const out = Bun.spawnSync(["/bin/sh", "-c", preamble], {
      cwd: DIR,
      env: { PATH: `${join(DIR, "bin")}:/usr/bin:/bin`, HOME: DIR },
    }).stdout.toString();
    return out.split("\n").slice(0, -1);
  };

  test("an inline shell execs sudo, which execs bash -l after the up marker", () => {
    const { args } = buildRemoteSpawn("web1", "inline", params({ env: { MODE: "it's live" } }), quiet, NONCE);
    expect(args.slice(0, 2)).toEqual(["-t", "web1"]);
    const expected = sudoArgs("root", { MODE: "it's live" }, "bash -l", NONCE, quiet);
    expect(sudoArgvOf(args[2]!)).toEqual(expected);
  });

  test("the terminal runs the target user's own shell, and prints no up marker", () => {
    const { args } = buildRemoteSpawn("web1", "terminal", params({}), quiet, NONCE);
    expect(sudoArgvOf(args[2]!)).toEqual(sudoArgs("root", {}, `"$SHELL" -l`, null, quiet));
  });

  test("cwd stays ahead of sudo, which runs its command where it started", () => {
    const { args } = buildRemoteSpawn("web1", "inline", params({ cwd: "/srv" }), quiet, NONCE);
    expect(args[2]).toMatch(/^cd -- '\/srv' .*; exec sudo /);
  });

  test("the inline env is exported inside sudo's script, never ahead of it", () => {
    const { args } = buildRemoteSpawn("web1", "inline", params({ env: { A: "1" } }), quiet, NONCE);
    expect(args[2]).not.toMatch(/^export|; export A/);
  });

  test("a sudo value that is not a user name throws", () => {
    expect(() => buildRemoteSpawn("web1", "inline", params({ sudo: "-s" }), quiet, NONCE)).toThrow();
  });
});

describe("a sudo shell on a real pty", () => {
  // Prompts and reads a password on the tty the way sudo does, then runs its
  // command. A block line written before the shell is up would be read here
  // as the password, and the run would fail with "Sorry".
  const PROMPTING = () => {
    const path = join(DIR, "prompting");
    writeFileSync(
      path,
      "#!/bin/sh\nprintf 'Password:'\nstty -echo\nread -r pw\nstty echo\nprintf '\\n'\n" +
        '[ "$pw" = secret ] || { echo Sorry; exit 1; }\n' +
        '[ "$1" = -u ] && shift 2\n[ "$1" = -- ] && shift\nexec "$@"\n',
    );
    chmodSync(path, 0o755);
    return path;
  };

  test("the block waits out the password prompt and runs in the shell behind it", async () => {
    const { PtyProcess } = await import("./pty");
    const { InlinePool } = await import("./inlinePool");
    const env = { PATH: "/usr/bin:/bin", TERM: "xterm-256color", HOME: DIR };
    const sudo = PROMPTING();
    const pool = new InlinePool(
      () =>
        Object.assign(
          new PtyProcess({
            executable: sudo,
            args: sudoArgs("root", { X: "it's set" }, "'/bin/bash' '--norc' '--noprofile' '-i'", NONCE, quiet),
            env,
            cwd: DIR,
            interruptViaChar: true,
          }),
          { announces: true },
        ),
      NONCE,
    );
    let out = "";
    let ended: number | null | undefined;
    const pump = async (until: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!until()) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(out)}`);
        pool.drain((ev) => {
          if (ev.type === "output") out += new TextDecoder().decode(ev.data);
          if (ev.type === "ended") ended = ev.exitCode;
        });
        await Bun.sleep(10);
      }
    };
    try {
      pool.run("note", "a", `echo "X=$X"`, { client: "" });
      await pump(() => out.includes("Password:"));
      pool.input("note", "a", new TextEncoder().encode("secret\r"));
      await pump(() => ended !== undefined);
      expect(out).not.toContain("Sorry");
      expect(out).toContain("X=it's set");
      expect(ended).toBe(0);
    } finally {
      pool.closeAll();
    }
  });
});
