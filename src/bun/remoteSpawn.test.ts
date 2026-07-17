import { describe, expect, test } from "bun:test";
import { buildRemoteSpawn, shellQuote, SSH_PATH } from "./remoteSpawn";
import type { NoteParams } from "../shared/frontmatter";

const noParams = (over: Partial<NoteParams> = {}): NoteParams => ({
  cwd: null,
  profile: null,
  envFile: null,
  env: {},
  hosts: ["web1"],
  ...over,
});

const quiet = () => {};

describe("shellQuote", () => {
  test("a quoted value is inert whatever it holds", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("has space")).toBe("'has space'");
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote("$(rm -rf ~)")).toBe(`'$(rm -rf ~)'`);
  });
});

describe("buildRemoteSpawn", () => {
  test("a bare terminal session is plain ssh: no command, sshd runs the login shell", () => {
    const { executable, args } = buildRemoteSpawn("web1", "terminal", noParams(), quiet);
    expect(executable).toBe(SSH_PATH);
    expect(args).toEqual(["-t", "web1"]);
  });

  test("an inline shell is always bash, because the marker hook must land", () => {
    const { args } = buildRemoteSpawn("web1", "inline", noParams(), quiet);
    expect(args).toEqual(["-t", "web1", "exec bash -l"]);
  });

  test("cwd rides as a cd that degrades to the remote home, like the local fallback", () => {
    const { args } = buildRemoteSpawn("web1", "terminal", noParams({ cwd: "/srv/app" }), quiet);
    expect(args[2]).toContain(`cd -- '/srv/app' 2>/dev/null ||`);
    expect(args[2]).toContain(`exec "$SHELL" -l`);
  });

  test("~ paths anchor to the REMOTE home: a quoted tilde would never expand", () => {
    const { args } = buildRemoteSpawn("web1", "terminal", noParams({ cwd: "~/proj x" }), quiet);
    expect(args[2]).toContain(`cd -- "$HOME"/'proj x'`);
    const home = buildRemoteSpawn("web1", "terminal", noParams({ cwd: "~" }), quiet);
    expect(home.args[2]).toContain(`cd -- "$HOME" 2>/dev/null`);
  });

  test("inline env crosses as quoted exports; a bad name warns and is dropped", () => {
    const warns: string[] = [];
    const { args } = buildRemoteSpawn(
      "web1",
      "inline",
      noParams({ env: { NODE_ENV: "dev", "BAD NAME": "x" } }),
      (m) => warns.push(m),
    );
    expect(args[2]).toContain(`export NODE_ENV='dev'`);
    expect(args[2]).not.toContain("BAD NAME");
    expect(warns.length).toBe(1);
  });

  test("profile and envFile stay local: secrets must not reach a remote process table", () => {
    const warns: string[] = [];
    const { args } = buildRemoteSpawn(
      "web1",
      "terminal",
      noParams({ profile: "petstore", envFile: "./.env" }),
      (m) => warns.push(m),
    );
    // Neither value appears anywhere in the argv.
    expect(args.join(" ")).not.toContain("petstore");
    expect(args.join(" ")).not.toContain(".env");
    expect(warns.length).toBe(2);
    // With nothing else declared, the terminal still gets the bare session.
    expect(args).toEqual(["-t", "web1"]);
  });

  test("a host that is not an ssh destination throws: degrading would run code elsewhere", () => {
    expect(() => buildRemoteSpawn("-oProxyCommand=x", "inline", noParams(), quiet)).toThrow();
    expect(() => buildRemoteSpawn("local", "inline", noParams(), quiet)).toThrow();
    expect(() => buildRemoteSpawn("a b", "inline", noParams(), quiet)).toThrow();
  });

  test("the preamble is one argv element, joined with semicolons", () => {
    const { args } = buildRemoteSpawn(
      "deploy@prod",
      "inline",
      noParams({ cwd: "/srv", env: { A: "1" } }),
      quiet,
    );
    expect(args.length).toBe(3);
    expect(args[2]).toMatch(/; export A='1'; exec bash -l$/);
  });
});
