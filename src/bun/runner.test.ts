import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { interpretersFor, runnerFor } from "./runner";

const INTERP = DEFAULT_SETTINGS.blocks.interpreters;
const BUN = "/Applications/My Ledge.app/Contents/MacOS/bun";

describe("runnerFor", () => {
  test("shell languages source their file into the note's shell", () => {
    for (const lang of ["sh", "bash", "zsh", "shell", "console", null]) {
      const spec = runnerFor("b1", lang, "cd /tmp && ls", INTERP, BUN);
      expect(spec.kind).toBe("shell");
      expect(spec.path).toBe("/tmp/ledge-run-b1.sh");
      expect(spec.contents).toBe("cd /tmp && ls");
      expect(spec.command).toBe("source /tmp/ledge-run-b1.sh");
    }
  });

  // The original bug: a ```node fence was written to a .sh and sourced, so zsh
  // read console.log(123) as shell ("unknown file attribute").
  test("node fences run under node, not the shell", () => {
    const spec = runnerFor("b2", "node", "console.log(123)", INTERP, BUN);
    expect(spec.kind).toBe("interpreter");
    expect(spec.path).toBe("/tmp/ledge-run-b2.js");
    expect(spec.command).toBe("node /tmp/ledge-run-b2.js");
  });

  test("language aliases share one interpreter and extension", () => {
    for (const lang of ["python", "python3", "py"]) {
      const spec = runnerFor("b3", lang, "print(1)", INTERP, BUN);
      expect(spec.path).toBe("/tmp/ledge-run-b3.py");
      expect(spec.command).toBe("python3 /tmp/ledge-run-b3.py");
    }
  });

  test("fence language matches case-insensitively, like blocks.runnable", () => {
    const spec = runnerFor("b4", "Python", "print(1)", INTERP, BUN);
    expect(spec.command).toBe("python3 /tmp/ledge-run-b4.py");
  });

  test("typescript runs on the bundled bun, quoted against bundle-path spaces", () => {
    const spec = runnerFor("b5", "ts", "const n: number = 1; console.log(n)", INTERP, BUN);
    expect(spec.path).toBe("/tmp/ledge-run-b5.ts");
    expect(spec.command).toBe(`"${BUN}" run /tmp/ledge-run-b5.ts`);
  });

  test("a user override replaces the bundled-bun special case", () => {
    const spec = runnerFor("b6", "ts", "1", { ...INTERP, ts: "/opt/bun/bin/bun run" }, BUN);
    expect(spec.command).toBe("/opt/bun/bin/bun run /tmp/ledge-run-b6.ts");
  });

  test("php gets its opening tag supplied when the fence omits it", () => {
    const spec = runnerFor("b7", "php", 'echo "hi";', INTERP, BUN);
    expect(spec.contents).toBe('<?php\necho "hi";');
    expect(spec.command).toBe("php /tmp/ledge-run-b7.php");
  });

  test("php keeps an explicit tag untouched", () => {
    const code = '<?php\necho "hi";';
    expect(runnerFor("b8", "php", code, INTERP, BUN).contents).toBe(code);
  });

  test("a user-mapped language falls back to the fence word as extension", () => {
    const spec = runnerFor("b9", "lua", "print(1)", { ...INTERP, lua: "lua" }, BUN);
    expect(spec.path).toBe("/tmp/ledge-run-b9.lua");
    expect(spec.command).toBe("lua /tmp/ledge-run-b9.lua");
  });

  test("prompt fences feed the block body to the agent CLI on stdin, ledge tools pre-allowed", () => {
    // The interpreter value ends with `<`: verbatim insertion makes it a
    // redirect, because `claude -p /tmp/file` would read the PATH as the
    // prompt. No shim script — the shell is the shim. The allow flag is
    // load-bearing too: print mode cannot ask permission, so without it a
    // write-intent block ends with "I wasn't allowed to write".
    const spec = runnerFor("b11", "prompt", "Summarize this note as a haiku", INTERP, BUN);
    expect(spec.kind).toBe("interpreter");
    expect(spec.path).toBe("/tmp/ledge-run-b11.prompt");
    expect(spec.contents).toBe("Summarize this note as a haiku");
    // The env prefix marks the session one-shot; the MCP server's initialize
    // instructions read it and tell the agent not to ask follow-ups.
    expect(spec.command).toBe("LEDGE_PROMPT_BLOCK=1 claude --allowedTools mcp__ledge -p < /tmp/ledge-run-b11.prompt");
  });

  test("a hostile fence word cannot shape the temp path", () => {
    const key = "../../x";
    const spec = runnerFor("b10", key, "1", { [key]: "cat" }, BUN);
    expect(spec.path).toBe("/tmp/ledge-run-b10.x");
  });
});

describe("runnerFor (remote)", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  test("a remote shell block writes itself in-band, then sources as usual", () => {
    const code = "cd /srv && ls";
    const spec = runnerFor("r1", "sh", code, INTERP, BUN, true);
    expect(spec.kind).toBe("shell");
    expect(spec.remote).toBe(true);
    expect(spec.command).toBe(
      `printf '%s' '${b64(code)}' | base64 --decode > /tmp/ledge-run-r1.sh && source /tmp/ledge-run-r1.sh`,
    );
  });

  test("any body is inert on the command line, because base64 has no metacharacters", () => {
    // The whole reason for the in-band base64: this body would otherwise need
    // quoting for quotes, $(), newlines, and the markers' own printf.
    const code = "echo \"$(rm -rf ~)\"; echo 'don'\\''t'\n\x1b]133;D\x07";
    const spec = runnerFor("r2", null, code, INTERP, BUN, true);
    const arg = spec.command.match(/printf '%s' '([^']*)'/)?.[1];
    expect(arg).toBe(b64(code));
    expect(arg).toMatch(/^[A-Za-z0-9+/=]*$/);
  });

  test("a remote interpreted block runs the remote PATH's interpreter on the remote file", () => {
    const spec = runnerFor("r3", "python", "print(1)", INTERP, BUN, true);
    expect(spec.kind).toBe("interpreter");
    expect(spec.command).toBe(
      `printf '%s' '${b64("print(1)")}' | base64 --decode > /tmp/ledge-run-r3.py && python3 /tmp/ledge-run-r3.py`,
    );
  });

  test("remote typescript means the remote's bun, never the bundled path", () => {
    // The bundle's absolute path is meaningless on another machine; a host
    // without bun fails with its shell's own "command not found".
    const spec = runnerFor("r4", "ts", "1", INTERP, BUN, true);
    expect(spec.command).toContain("bun run /tmp/ledge-run-r4.ts");
    expect(spec.command).not.toContain(BUN);
  });

  test("a remote prompt block rides in-band, then feeds the remote claude on stdin", () => {
    const spec = runnerFor("r7", "prompt", "Check disk usage and summarize", INTERP, BUN, true);
    expect(spec.command).toBe(
      `printf '%s' '${b64("Check disk usage and summarize")}' | base64 --decode > /tmp/ledge-run-r7.prompt && LEDGE_PROMPT_BLOCK=1 claude --allowedTools mcp__ledge -p < /tmp/ledge-run-r7.prompt`,
    );
  });

  test("the php tag is supplied before encoding, so both machines run the same bytes", () => {
    const spec = runnerFor("r5", "php", 'echo "hi";', INTERP, BUN, true);
    expect(spec.command).toContain(b64('<?php\necho "hi";'));
  });

  test("local runs are byte-identical to what they were before remote existed", () => {
    const spec = runnerFor("r6", "sh", "ls", INTERP, BUN);
    expect(spec.remote).toBe(false);
    expect(spec.command).toBe("source /tmp/ledge-run-r6.sh");
  });
});

describe("interpretersFor", () => {
  const blocks = (hostInterpreters: Record<string, Record<string, string>>) => ({
    interpreters: { python: "python3", ts: "bun" },
    hostInterpreters,
  });

  test("no matching section: the base map, exactly", () => {
    expect(interpretersFor("local", blocks({}))).toEqual({ python: "python3", ts: "bun" });
    expect(interpretersFor("web1", blocks({ "db-*": { python: "/opt/py" } }))).toEqual({
      python: "python3",
      ts: "bun",
    });
  });

  test("a matching host overrides only the languages it names", () => {
    const out = interpretersFor("deploy@prod-01", blocks({ "deploy@prod-01": { python: "/opt/py312/bin/python3" } }));
    expect(out["python"]).toBe("/opt/py312/bin/python3");
    expect(out["ts"]).toBe("bun"); // untouched
  });

  test("a * glob covers a numbered fleet with one entry", () => {
    const b = blocks({ "deploy@anypost-*": { ts: "~/.bun/bin/bun run" } });
    expect(interpretersFor("deploy@anypost-app-prod-01", b)["ts"]).toBe("~/.bun/bin/bun run");
    expect(interpretersFor("deploy@anypost-app-prod-02", b)["ts"]).toBe("~/.bun/bin/bun run");
    expect(interpretersFor("deploy@other", b)["ts"]).toBe("bun");
  });

  test("matching sections merge in file order, later keys winning", () => {
    const b = blocks({
      "deploy@*": { python: "/usr/bin/python3" },
      "deploy@prod-01": { python: "/opt/py" },
    });
    expect(interpretersFor("deploy@prod-01", b)["python"]).toBe("/opt/py");
    expect(interpretersFor("deploy@prod-02", b)["python"]).toBe("/usr/bin/python3");
  });

  test('"local" is a matchable host name like any other', () => {
    const b = blocks({ local: { python: "/opt/homebrew/bin/python3" } });
    expect(interpretersFor("local", b)["python"]).toBe("/opt/homebrew/bin/python3");
    expect(interpretersFor("web1", b)["python"]).toBe("python3");
  });

  test("glob is whole-string: a pattern is not a substring search", () => {
    // "prod" must not match "preprod-1" — partial matches would silently
    // retarget interpreters on hosts the entry never named.
    const b = blocks({ prod: { python: "/opt/py" } });
    expect(interpretersFor("preprod-1", b)["python"]).toBe("python3");
    expect(interpretersFor("prod", b)["python"]).toBe("/opt/py");
  });

  test("regex metacharacters in a pattern are literal, only * is magic", () => {
    const b = blocks({ "user@10.0.0.1": { python: "/opt/py" } });
    expect(interpretersFor("user@10.0.0.1", b)["python"]).toBe("/opt/py");
    expect(interpretersFor("user@10x0y0z1", b)["python"]).toBe("python3"); // "." stays a dot
  });
});
