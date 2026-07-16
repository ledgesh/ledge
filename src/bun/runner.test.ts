import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { runnerFor } from "./runner";

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

  test("a hostile fence word cannot shape the temp path", () => {
    const key = "../../x";
    const spec = runnerFor("b10", key, "1", { [key]: "cat" }, BUN);
    expect(spec.path).toBe("/tmp/ledge-run-b10.x");
  });
});
