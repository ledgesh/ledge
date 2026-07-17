import { describe, expect, test } from "bun:test";
import { frontmatterEnd, parseFrontmatter } from "./frontmatter";

const fm = (inner: string, body = "# Title\n") => `---\n${inner}---\n${body}`;

describe("frontmatterEnd", () => {
  test("a note with no frontmatter has no block", () => {
    expect(frontmatterEnd("# Title\nbody")).toBe(0);
    expect(frontmatterEnd("")).toBe(0);
  });

  test("the block must start on the very first line", () => {
    // A "---" further down is a markdown thematic break, not late frontmatter.
    expect(frontmatterEnd("\n---\ncwd: /x\n---\n")).toBe(0);
    expect(frontmatterEnd("# Title\n---\n---\n")).toBe(0);
  });

  test("the end offset points at the first content character", () => {
    const text = "---\ncwd: /x\n---\n# Title\n";
    expect(text.slice(frontmatterEnd(text))).toBe("# Title\n");
  });

  test("an unterminated opener is content, not a block that ate the note", () => {
    expect(frontmatterEnd("---\ncwd: /x\n# Title\n")).toBe(0);
    expect(frontmatterEnd("---\n")).toBe(0);
    expect(frontmatterEnd("---")).toBe(0);
  });

  test("a closing fence with no trailing newline still closes", () => {
    const text = "---\ncwd: /x\n---";
    expect(frontmatterEnd(text)).toBe(text.length);
  });

  test("fences tolerate trailing spaces and CRLF, nothing else", () => {
    expect(frontmatterEnd("---  \ncwd: /x\n---\t\nbody")).toBeGreaterThan(0);
    expect(frontmatterEnd("---\r\ncwd: /x\r\n---\r\nbody")).toBeGreaterThan(0);
    // "----" is a thematic break, and "--- x" is prose.
    expect(frontmatterEnd("----\ncwd: /x\n---\n")).toBe(0);
    expect(frontmatterEnd("--- x\ncwd: /x\n---\n")).toBe(0);
  });

  test("an empty block is still a block", () => {
    const text = "---\n---\n# Title\n";
    expect(text.slice(frontmatterEnd(text))).toBe("# Title\n");
  });
});

describe("parseFrontmatter", () => {
  test("a note with no frontmatter yields empty params and no problems", () => {
    const { params, problems, end } = parseFrontmatter("# Title\nbody");
    expect(params).toEqual({ cwd: null, profile: null, envFile: null, env: {} });
    expect(problems).toEqual([]);
    expect(end).toBe(0);
  });

  test("all four keys parse together", () => {
    const { params, problems } = parseFrontmatter(
      fm("cwd: ~/Projects/ledge\nprofile: petstore\nenvFile: ./.env\nenv:\n  NODE_ENV: development\n  PORT: 3000\n"),
    );
    expect(params).toEqual({
      cwd: "~/Projects/ledge",
      profile: "petstore",
      envFile: "./.env",
      env: { NODE_ENV: "development", PORT: "3000" },
    });
    expect(problems).toEqual([]);
  });

  test("values may be quoted, and the quotes come off", () => {
    const { params } = parseFrontmatter(fm(`cwd: "~/My Notes"\nenv:\n  GREETING: 'hello: world'\n`));
    expect(params.cwd).toBe("~/My Notes");
    expect(params.env["GREETING"]).toBe("hello: world");
  });

  test("a quote inside a value is not a wrapping pair", () => {
    const { params } = parseFrontmatter(fm(`env:\n  MSG: it's fine\n`));
    expect(params.env["MSG"]).toBe("it's fine");
  });

  test("env values split on the FIRST colon, so URLs survive", () => {
    const { params, problems } = parseFrontmatter(fm("env:\n  PG: postgres://u:pw@host:5432/db\n"));
    expect(params.env["PG"]).toBe("postgres://u:pw@host:5432/db");
    expect(problems).toEqual([]);
  });

  test("blank lines and full-line comments are ignored, even inside env", () => {
    const { params, problems } = parseFrontmatter(
      fm("# the dev database\ncwd: /x\n\nenv:\n  # local only\n  A: 1\n\n  B: 2\n"),
    );
    expect(params.env).toEqual({ A: "1", B: "2" });
    expect(problems).toEqual([]);
  });

  test("inline comments are NOT stripped: a value may contain #", () => {
    const { params } = parseFrontmatter(fm("env:\n  URL: https://x.test/page#anchor\n"));
    expect(params.env["URL"]).toBe("https://x.test/page#anchor");
  });

  test("an unknown key is reported, not silently ignored", () => {
    // Silence would read as "my frontmatter does nothing"; say so instead.
    const { params, problems } = parseFrontmatter(fm("cwds: /x\ncwd: /y\n"));
    expect(problems).toEqual([`unknown key "cwds"`]);
    expect(params.cwd).toBe("/y");
  });

  test("a bad line costs that line, never the rest of the block", () => {
    const { params, problems } = parseFrontmatter(fm("just some prose\ncwd: /x\nprofile: ok\n"));
    expect(problems.length).toBe(1);
    expect(params.cwd).toBe("/x");
    expect(params.profile).toBe("ok");
  });

  test("a profile name is safe by construction or refused", () => {
    // The name becomes a filename under the profiles dir: separators and dots
    // would make "which file is this?" a security question instead of a lookup.
    for (const bad of ["../evil", ".hidden", "a/b", "a.env", "petstore prod"]) {
      const { params, problems } = parseFrontmatter(fm(`profile: ${bad}\n`));
      expect(params.profile).toBeNull();
      expect(problems.length).toBe(1);
    }
    const { params } = parseFrontmatter(fm("profile: stripe-test_2\n"));
    expect(params.profile).toBe("stripe-test_2");
  });

  test("env names must be shell-reachable", () => {
    const { params, problems } = parseFrontmatter(fm("env:\n  9LIVES: no\n  MY VAR: no\n  OK_1: yes\n"));
    expect(params.env).toEqual({ OK_1: "yes" });
    expect(problems.length).toBe(2);
  });

  test("an indented line outside env: is a mistake worth naming", () => {
    const { problems } = parseFrontmatter(fm("cwd: /x\n  stray: line\n"));
    expect(problems).toEqual([`indented line outside "env:": "stray: line"`]);
  });

  test("a top-level key after the env map closes it", () => {
    const { params, problems } = parseFrontmatter(fm("env:\n  A: 1\ncwd: /x\n  B: 2\n"));
    expect(params.env).toEqual({ A: "1" });
    expect(params.cwd).toBe("/x");
    expect(problems.length).toBe(1); // B landed outside the map
  });

  test("empty values are reported and cost only their field", () => {
    const { params, problems } = parseFrontmatter(fm("cwd:\nprofile: ok\nenv:\n  A:\n"));
    expect(params.cwd).toBeNull();
    expect(params.profile).toBe("ok");
    expect(params.env).toEqual({});
    expect(problems.length).toBe(2);
  });

  test("env with an inline value is refused: the map is the only shape", () => {
    const { params, problems } = parseFrontmatter(fm("env: A=1\n"));
    expect(params.env).toEqual({});
    expect(problems.length).toBe(1);
  });

  test("a duplicate key: the last one wins", () => {
    const { params } = parseFrontmatter(fm("cwd: /first\ncwd: /second\n"));
    expect(params.cwd).toBe("/second");
  });

  test("CRLF notes parse the same as LF ones", () => {
    const { params, problems } = parseFrontmatter("---\r\ncwd: /x\r\nenv:\r\n  A: 1\r\n---\r\n# T\r\n");
    expect(params.cwd).toBe("/x");
    expect(params.env).toEqual({ A: "1" });
    expect(problems).toEqual([]);
  });

  test("an empty block is valid and empty", () => {
    const { params, problems, end } = parseFrontmatter("---\n---\n# Title\n");
    expect(params).toEqual({ cwd: null, profile: null, envFile: null, env: {} });
    expect(problems).toEqual([]);
    expect(end).toBeGreaterThan(0);
  });
});
