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
    expect(params).toEqual({ cwd: null, profile: null, envFile: null, env: {}, hosts: [], tags: [], template: false, locked: null });
    expect(problems).toEqual([]);
    expect(end).toBe(0);
  });

  test("all eight keys parse together", () => {
    const { params, problems } = parseFrontmatter(
      fm(
        "cwd: ~/Projects/ledge\nprofile: petstore\nenvFile: ./.env\nhost: web1 deploy@prod\ntags: work, ledge\ntemplate: true\nlocked: v1.aa.bb.cc\nenv:\n  NODE_ENV: development\n  PORT: 3000\n",
      ),
    );
    expect(params).toEqual({
      cwd: "~/Projects/ledge",
      profile: "petstore",
      envFile: "./.env",
      env: { NODE_ENV: "development", PORT: "3000" },
      hosts: ["web1", "deploy@prod"],
      tags: ["work", "ledge"],
      template: true,
      locked: "v1.aa.bb.cc",
    });
    expect(problems).toEqual([]);
  });

  test("locked carries its value opaquely; only an empty one costs the line", () => {
    // The value's structure is Bun's (vault.ts parseLockedHeader) — the
    // grammar stores whatever non-empty string is there, so a DAMAGED header
    // still reads as locked (refuse-to-decrypt, never unlocked-after-all).
    expect(parseFrontmatter(fm("locked: not-even-close\n")).params.locked).toBe("not-even-close");
    const { params, problems } = parseFrontmatter(fm("locked:\n"));
    expect(params.locked).toBeNull();
    expect(problems).toHaveLength(1);
    // An INDENTED locked under env: is an env var named locked, not a header.
    expect(parseFrontmatter(fm("env:\n  locked: yes\n")).params.locked).toBeNull();
  });

  test("template takes exactly true, false, or daily; anything else costs the line", () => {
    expect(parseFrontmatter(fm("template: true\n")).params.template).toBe(true);
    expect(parseFrontmatter(fm("template: false\n")).params.template).toBe(false);
    // The `daily` value claims the role: this template seeds each day's note.
    expect(parseFrontmatter(fm("template: daily\n")).params.template).toBe("daily");
    const { params, problems } = parseFrontmatter(fm("template: yes\n"));
    expect(params.template).toBe(false);
    expect(problems).toEqual([`"template" must be true, false, or daily: "yes"`]);
  });

  test("an env var named template is an env var, not the marker", () => {
    const { params, problems } = parseFrontmatter(fm("env:\n  template: jinja\n"));
    expect(params.template).toBe(false);
    expect(params.env["template"]).toBe("jinja");
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

  test("host: parses a flat list, comma- or space-separated", () => {
    expect(parseFrontmatter(fm("host: web1\n")).params.hosts).toEqual(["web1"]);
    expect(parseFrontmatter(fm("host: web1 deploy@prod\n")).params.hosts).toEqual(["web1", "deploy@prod"]);
    expect(parseFrontmatter(fm("host: web1, deploy@prod,db-2\n")).params.hosts).toEqual([
      "web1",
      "deploy@prod",
      "db-2",
    ]);
  });

  test("host: accepts the reserved word local alongside real machines", () => {
    const { params, problems } = parseFrontmatter(fm("host: local staging\n"));
    expect(params.hosts).toEqual(["local", "staging"]);
    expect(problems).toEqual([]);
  });

  test("a host entry is an ssh destination by construction or refused", () => {
    // The destination becomes ssh argv: a leading "-" would read as an option
    // (option injection), and quotes/spaces would break the remote command.
    for (const bad of ["-oProxyCommand=evil", "a;b", "h'x", "web$1"]) {
      const { params, problems } = parseFrontmatter(fm(`host: ${bad}\n`));
      expect(params.hosts).toEqual([]);
      expect(problems.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("a bad host entry costs itself, not the machines beside it", () => {
    const { params, problems } = parseFrontmatter(fm("host: web1 'bad' db-2\n"));
    expect(params.hosts).toEqual(["web1", "db-2"]);
    expect(problems.length).toBe(1);
  });

  test("host entries dedupe, and a repeated host: line replaces the list", () => {
    expect(parseFrontmatter(fm("host: web1 web1\n")).params.hosts).toEqual(["web1"]);
    expect(parseFrontmatter(fm("host: web1\nhost: db-2\n")).params.hosts).toEqual(["db-2"]);
  });

  test("tags: parses a flat list, comma- or space-separated", () => {
    expect(parseFrontmatter(fm("tags: work\n")).params.tags).toEqual(["work"]);
    expect(parseFrontmatter(fm("tags: work home\n")).params.tags).toEqual(["work", "home"]);
    expect(parseFrontmatter(fm("tags: work, home,project/ledge\n")).params.tags).toEqual([
      "work",
      "home",
      "project/ledge",
    ]);
  });

  test("tags: accepts the body's own spelling — a leading # comes off", () => {
    const { params, problems } = parseFrontmatter(fm("tags: #work, home\n"));
    expect(params.tags).toEqual(["work", "home"]);
    expect(problems).toEqual([]);
  });

  test("a tags entry is a tag by construction or refused", () => {
    // Same grammar as inline #tags: at least one letter or "_", nothing
    // outside letters/digits/_/-//. An all-digit token is a year or an issue
    // number, not a tag.
    for (const bad of ["123", "2024", "b@d", "a.b", "#"]) {
      const { params, problems } = parseFrontmatter(fm(`tags: ${bad}\n`));
      expect(params.tags).toEqual([]);
      expect(problems.length).toBeGreaterThanOrEqual(1);
    }
    expect(parseFrontmatter(fm("tags: fff _draft café\n")).params.tags).toEqual([
      "fff",
      "_draft",
      "café",
    ]);
  });

  test("a bad tags entry costs itself, not the tags beside it", () => {
    const { params, problems } = parseFrontmatter(fm("tags: work 123 home\n"));
    expect(params.tags).toEqual(["work", "home"]);
    expect(problems.length).toBe(1);
  });

  test("tags dedupe case-folded, and a repeated tags: line replaces the list", () => {
    // First spelling wins the dedupe; identity is the folded form.
    expect(parseFrontmatter(fm("tags: Work work\n")).params.tags).toEqual(["Work"]);
    expect(parseFrontmatter(fm("tags: work\ntags: home\n")).params.tags).toEqual(["home"]);
  });

  test("an empty tags: line is reported and keeps the earlier list", () => {
    const { params, problems } = parseFrontmatter(fm("tags: work\ntags:\n"));
    expect(params.tags).toEqual(["work"]);
    expect(problems.length).toBe(1);
  });

  test("CRLF notes parse the same as LF ones", () => {
    const { params, problems } = parseFrontmatter("---\r\ncwd: /x\r\nenv:\r\n  A: 1\r\n---\r\n# T\r\n");
    expect(params.cwd).toBe("/x");
    expect(params.env).toEqual({ A: "1" });
    expect(problems).toEqual([]);
  });

  test("an empty block is valid and empty", () => {
    const { params, problems, end } = parseFrontmatter("---\n---\n# Title\n");
    expect(params).toEqual({ cwd: null, profile: null, envFile: null, env: {}, hosts: [], tags: [], template: false, locked: null });
    expect(problems).toEqual([]);
    expect(end).toBeGreaterThan(0);
  });
});
