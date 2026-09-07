import { describe, expect, test } from "bun:test";
import { frontmatterEnd, parseFrontmatter, setFavoriteLine } from "./frontmatter";

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
    expect(params).toEqual({ cwd: null, profile: null, envFile: null, env: {}, hosts: [], tags: [], template: false, confirm: false, favorite: false, locked: null });
    expect(problems).toEqual([]);
    expect(end).toBe(0);
  });

  test("all ten keys parse together", () => {
    const { params, problems } = parseFrontmatter(
      fm(
        "cwd: ~/Projects/ledge\nprofile: petstore\nenvFile: ./.env\nhost: web1 deploy@prod\ntags: work, ledge\ntemplate: true\nconfirm: true\nfavorite: true\nlocked: v1.aa.bb.cc\nenv:\n  NODE_ENV: development\n  PORT: 3000\n",
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
      confirm: true,
      favorite: true,
      locked: "v1.aa.bb.cc",
    });
    expect(problems).toEqual([]);
  });

  test("locked carries its value opaquely; only an empty one costs the line", () => {
    // The value's structure belongs to Bun (vault.ts parseLockedHeader). This
    // grammar stores whatever non-empty string is there, so a damaged header
    // still counts as locked. Bun then refuses to decrypt it, and the note
    // never opens as if it had been unlocked all along.
    expect(parseFrontmatter(fm("locked: not-even-close\n")).params.locked).toBe("not-even-close");
    const { params, problems } = parseFrontmatter(fm("locked:\n"));
    expect(params.locked).toBeNull();
    expect(problems).toHaveLength(1);
    // A locked line indented under env: is an env var named locked, not a
    // header.
    expect(parseFrontmatter(fm("env:\n  locked: yes\n")).params.locked).toBeNull();
  });

  test("template takes exactly true, false, or daily; anything else costs the line", () => {
    expect(parseFrontmatter(fm("template: true\n")).params.template).toBe(true);
    expect(parseFrontmatter(fm("template: false\n")).params.template).toBe(false);
    // `template: daily` claims the daily role. The template holding it seeds
    // each day's note.
    expect(parseFrontmatter(fm("template: daily\n")).params.template).toBe("daily");
    const { params, problems } = parseFrontmatter(fm("template: yes\n"));
    expect(params.template).toBe(false);
    expect(problems).toEqual([{ line: 2, message: `"template" must be true, false, or daily: "yes"` }]);
  });

  test("confirm takes exactly true or false; anything else costs the line", () => {
    expect(parseFrontmatter(fm("confirm: true\n")).params.confirm).toBe(true);
    expect(parseFrontmatter(fm("confirm: false\n")).params.confirm).toBe(false);
    const { params, problems } = parseFrontmatter(fm("confirm: always\n"));
    // The parser does not read a typo as "asks first". It falls back to false
    // and reports the line rather than guessing in silence. The key exists so
    // the note's author can tell which blocks pause.
    expect(params.confirm).toBe(false);
    expect(problems).toEqual([{ line: 2, message: `"confirm" must be true or false: "always"` }]);
  });

  test("favorite takes exactly true or false; anything else costs the line", () => {
    expect(parseFrontmatter(fm("favorite: true\n")).params.favorite).toBe(true);
    expect(parseFrontmatter(fm("favorite: false\n")).params.favorite).toBe(false);
    const { params, problems } = parseFrontmatter(fm("favorite: yes\n"));
    // A typo does not put the note in the Favorites section. The section is
    // short by design, and a row nobody asked for is a row nobody trusts.
    expect(params.favorite).toBe(false);
    expect(problems).toEqual([{ line: 2, message: `"favorite" must be true or false: "yes"` }]);
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
    // The parser reports the key instead of skipping it. Silence would leave
    // the note's author with frontmatter that does nothing and no way to see
    // why.
    const { params, problems } = parseFrontmatter(fm("cwds: /x\ncwd: /y\n"));
    expect(problems).toEqual([{ line: 2, message: `unknown key "cwds"` }]);
    expect(params.cwd).toBe("/y");
  });

  test("a bad line costs that line, never the rest of the block", () => {
    const { params, problems } = parseFrontmatter(fm("just some prose\ncwd: /x\nprofile: ok\n"));
    expect(problems.length).toBe(1);
    expect(params.cwd).toBe("/x");
    expect(params.profile).toBe("ok");
  });

  test("a profile name is safe by construction or refused", () => {
    // The name becomes a filename under the profiles dir, so the parser
    // accepts only letters, digits, "-" and "_" (isProfileName in
    // frontmatter.ts). No separators and no dots means no traversal and no
    // ".env"-style hidden file. Everything else, spaces included, is refused,
    // so nothing in the name needs escaping where it is used as a path.
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
    expect(problems).toEqual([{ line: 3, message: `indented line outside "env:": "stray: line"` }]);
  });

  test("a problem names the line it is on, counting the opening fence as 1", () => {
    // The editor draws each message beside the line the problem names
    // (mainview/editor/frontmatter.ts). A number that is off by one puts the
    // message beside the wrong line.
    const { problems } = parseFrontmatter(fm("cwd: /x\nnonsense\nprofile: 9 bad\n"));
    expect(problems).toEqual([
      { line: 3, message: `not a "key: value" line: "nonsense"` },
      { line: 4, message: `"profile" must be letters, digits, "-" or "_": "9 bad"` },
    ]);
  });

  test("blank and comment lines are counted, not skipped", () => {
    // The grammar ignores them, but they still occupy a line, so everything
    // below them shifts down by one.
    const { problems } = parseFrontmatter(fm("\n# just a note\n\ncwds: /x\n"));
    expect(problems).toEqual([{ line: 5, message: `unknown key "cwds"` }]);
  });

  test("one line can be wrong more than once", () => {
    // Degradation is per token, so a tags: line reports each refused token.
    // The editor joins the messages onto that line rather than showing only
    // the first.
    const { problems } = parseFrontmatter(fm("tags: 123 456 ok\n"));
    expect(problems.map((p) => p.line)).toEqual([2, 2]);
  });

  test("a CRLF block numbers its lines the same as an LF one", () => {
    const { problems } = parseFrontmatter("---\r\ncwd: /x\r\ncwds: /y\r\n---\r\n# T\r\n");
    expect(problems).toEqual([{ line: 3, message: `unknown key "cwds"` }]);
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

  test("tags: takes the bracketed list too, the form other tools write", () => {
    // The parser takes the brackets off around the whole value and changes
    // nothing else. Obsidian and most Markdown editors spell a tag list as
    // this YAML flow sequence. A notes folder is often shared with them.
    const bracketed = parseFrontmatter(fm("tags: [ops, runbook]\n"));
    expect(bracketed.params.tags).toEqual(["ops", "runbook"]);
    expect(bracketed.problems).toEqual([]);
    expect(parseFrontmatter(fm("tags: [ops runbook]\n")).params.tags).toEqual(["ops", "runbook"]);
    expect(parseFrontmatter(fm("tags: [ops]\n")).params.tags).toEqual(["ops"]);
    // Quotes come off first, so a quoted list is still a list.
    expect(parseFrontmatter(fm('tags: "[ops, runbook]"\n')).params.tags).toEqual(["ops", "runbook"]);
  });

  test("an unbalanced bracket stays the typo it looks like", () => {
    // Only a matched wrapping pair is punctuation. The parser reports the odd
    // bracket, so a half-typed list does not read as a shorter one.
    const { params, problems } = parseFrontmatter(fm("tags: [ops, runbook\n"));
    expect(params.tags).toEqual(["runbook"]);
    expect(problems.length).toBe(1);
  });

  test("tags: [] declares no tags, and is not a problem", () => {
    // An explicitly empty list is a choice. A bare `tags:` is an unfinished
    // line, so only that one is reported.
    const { params, problems } = parseFrontmatter(fm("tags: []\n"));
    expect(params.tags).toEqual([]);
    expect(problems).toEqual([]);
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
    expect(params).toEqual({ cwd: null, profile: null, envFile: null, env: {}, hosts: [], tags: [], template: false, confirm: false, favorite: false, locked: null });
    expect(problems).toEqual([]);
    expect(end).toBeGreaterThan(0);
  });
});

// The Favorite command's half of the marker: the line goes in and comes out
// without disturbing anything else in the block (bun/notes.ts favoriteNote).
describe("setFavoriteLine", () => {
  test("a note with no block grows one holding just the marker", () => {
    expect(setFavoriteLine("# Title\n\nbody\n", true)).toBe("---\nfavorite: true\n---\n# Title\n\nbody\n");
  });

  test("the marker lands after the keys already there, and leaves them alone", () => {
    const text = fm("cwd: /tmp/proj\n# a comment\ntags: work\n");
    expect(setFavoriteLine(text, true)).toBe(fm("cwd: /tmp/proj\n# a comment\ntags: work\nfavorite: true\n"));
  });

  test("a hand-written false is turned over where it sits, not doubled", () => {
    const text = fm("favorite: false\ncwd: /tmp\n");
    expect(setFavoriteLine(text, true)).toBe(fm("favorite: true\ncwd: /tmp\n"));
  });

  test("unfavoriting takes the whole block when the marker was all of it", () => {
    // Favoriting a plain note and unfavoriting it leaves the note as it was
    // found, husk included. stripLockedLine's rule (bun/vault.ts).
    const plain = "# Title\n\nbody\n";
    expect(setFavoriteLine(setFavoriteLine(plain, true), false)).toBe(plain);
  });

  test("a block holding anything else is the user's and stays", () => {
    const text = fm("favorite: true\n# a comment\n");
    expect(setFavoriteLine(text, false)).toBe(fm("# a comment\n"));
  });

  test("either direction is a no-op when the note already reads that way", () => {
    const marked = fm("favorite: true\n");
    const plain = "# Title\n";
    expect(setFavoriteLine(marked, true)).toBe(marked);
    expect(setFavoriteLine(plain, false)).toBe(plain);
    expect(setFavoriteLine(fm("cwd: /tmp\n"), false)).toBe(fm("cwd: /tmp\n"));
  });

  test("an env var named favorite is left where it is", () => {
    // An indented line belongs to the env map. Stripping it would delete a
    // variable, and stamping over it would move the marker inside the map.
    const text = fm("env:\n  favorite: yes\n");
    expect(setFavoriteLine(text, false)).toBe(text);
    expect(setFavoriteLine(text, true)).toBe(fm("env:\n  favorite: yes\nfavorite: true\n"));
  });
});
