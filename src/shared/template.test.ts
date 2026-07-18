import { describe, expect, test } from "bun:test";
import {
  forceTitle,
  instantiateTemplate,
  isoDateOf,
  renderTemplate,
  setTemplateMarker,
  stripTemplateMarker,
  timeOf,
} from "./template";

// A fixed local instant: 2026-07-18 23:30 — late enough that UTC has already
// rolled to the 19th in every timezone west of Greenwich, which is what makes
// the "local, not UTC" assertions bite.
const NOW = new Date(2026, 6, 18, 23, 30);

describe("isoDateOf", () => {
  test("formats the LOCAL calendar date", () => {
    expect(isoDateOf(NOW)).toBe("2026-07-18");
    // Assert against the local accessors, never toISOString: in a western
    // timezone toISOString on this instant says the 19th.
    const d = new Date(2026, 0, 1, 0, 5);
    expect(isoDateOf(d)).toBe("2026-01-01");
  });

  test("pads single-digit months and days", () => {
    expect(isoDateOf(new Date(2026, 2, 5))).toBe("2026-03-05");
  });
});

describe("timeOf", () => {
  test("local 24h HH:MM, padded", () => {
    expect(timeOf(NOW)).toBe("23:30");
    expect(timeOf(new Date(2026, 6, 18, 9, 5))).toBe("09:05");
    expect(timeOf(new Date(2026, 6, 18, 0, 0))).toBe("00:00");
  });
});

describe("renderTemplate", () => {
  const vars = { title: "2026-07-18", now: NOW };

  test("substitutes every known token", () => {
    expect(renderTemplate("{{date}} {{time}} {{title}} {{yesterday}} {{tomorrow}}", vars)).toBe(
      "2026-07-18 23:30 2026-07-18 2026-07-17 2026-07-19",
    );
  });

  test("tolerates inner whitespace and case", () => {
    expect(renderTemplate("{{ date }} {{DATE}} {{ Tomorrow }}", vars)).toBe(
      "2026-07-18 2026-07-18 2026-07-19",
    );
  });

  test("an unknown token is left for the reader, not an error", () => {
    expect(renderTemplate("keep {{frobnicate}} and {{x_y}}", vars)).toBe(
      "keep {{frobnicate}} and {{x_y}}",
    );
  });

  test("non-token braces are untouched", () => {
    expect(renderTemplate("shell ${HOME} and {single} and {{}}", vars)).toBe(
      "shell ${HOME} and {single} and {{}}",
    );
  });

  test("yesterday and tomorrow cross month and year boundaries", () => {
    const newYear = { title: "t", now: new Date(2026, 0, 1) };
    expect(renderTemplate("{{yesterday}}", newYear)).toBe("2025-12-31");
    const monthEnd = { title: "t", now: new Date(2026, 6, 31) };
    expect(renderTemplate("{{tomorrow}}", monthEnd)).toBe("2026-08-01");
    // Leap day.
    expect(renderTemplate("{{tomorrow}}", { title: "t", now: new Date(2028, 1, 28) })).toBe(
      "2028-02-29",
    );
  });

  test("substitution reaches fence bodies", () => {
    const text = "# T\n\n```prompt\nSummarize [[{{yesterday}}]]\n```\n";
    expect(renderTemplate(text, vars)).toBe("# T\n\n```prompt\nSummarize [[2026-07-17]]\n```\n");
  });
});

describe("forceTitle", () => {
  test("replaces a differing H1", () => {
    expect(forceTitle("# Daily Template\n\nbody\n", "2026-07-18")).toBe("# 2026-07-18\n\nbody\n");
  });

  test("no-ops when the H1 already matches", () => {
    const text = "# 2026-07-18\n\nbody\n";
    expect(forceTitle(text, "2026-07-18")).toBe(text);
  });

  test("inserts an H1 when the template has none", () => {
    expect(forceTitle("just prose\n", "Untitled")).toBe("# Untitled\n\njust prose\n");
  });

  test("inserts after a frontmatter block, preserving its bytes", () => {
    const fm = "---\ncwd: ~/proj\ntags: journal\n---\n";
    expect(forceTitle(`${fm}\nprose\n`, "T")).toBe(`${fm}# T\n\nprose\n`);
    // No blank line under the fence: still inserts with a separator.
    expect(forceTitle(`${fm}prose\n`, "T")).toBe(`${fm}# T\n\nprose\n`);
  });

  test("replaces the H1 under a frontmatter block, per headingOf's rule", () => {
    const fm = "---\ncwd: ~/proj\n---\n";
    // headingOf skips blank lines under the fence — the replace must hit the
    // same line it reads, not the blank one.
    expect(forceTitle(`${fm}\n# Daily Template\n\nbody\n`, "2026-07-18")).toBe(
      `${fm}\n# 2026-07-18\n\nbody\n`,
    );
  });

  test("an ## subheading is content, not a title — H1 is inserted above it", () => {
    expect(forceTitle("## Agenda\n", "T")).toBe("# T\n\n## Agenda\n");
  });

  test("empty template becomes just the heading", () => {
    expect(forceTitle("", "T")).toBe("# T\n");
  });
});

describe("stripTemplateMarker", () => {
  test("removes the marker, keeps the rest of the block", () => {
    expect(stripTemplateMarker("---\ncwd: ~/proj\ntemplate: true\n---\n# T\n")).toBe(
      "---\ncwd: ~/proj\n---\n# T\n",
    );
  });

  test("a block that only held the marker loses its fences", () => {
    expect(stripTemplateMarker("---\ntemplate: true\n---\n# T\n\nbody\n")).toBe("# T\n\nbody\n");
  });

  test("strips whatever the value was — false and daily are marker lines too", () => {
    expect(stripTemplateMarker("---\ntemplate: false\n---\n# T\n")).toBe("# T\n");
    // The daily role must not reach instances either: a day's note claiming
    // template: daily would become tomorrow's template.
    expect(stripTemplateMarker("---\ntemplate: daily\n---\n# T\n")).toBe("# T\n");
  });

  test("never touches an env var named template", () => {
    const text = "---\nenv:\n  template: jinja\ntemplate: true\n---\n# T\n";
    expect(stripTemplateMarker(text)).toBe("---\nenv:\n  template: jinja\n---\n# T\n");
  });

  test("a comment keeps the block alive", () => {
    expect(stripTemplateMarker("---\n# meeting skeleton\ntemplate: true\n---\n# T\n")).toBe(
      "---\n# meeting skeleton\n---\n# T\n",
    );
  });

  test("no block, or no marker: byte-identical", () => {
    expect(stripTemplateMarker("# T\n\nbody\n")).toBe("# T\n\nbody\n");
    const fm = "---\ncwd: ~/proj\n---\n# T\n";
    expect(stripTemplateMarker(fm)).toBe(fm);
  });
});

describe("setTemplateMarker", () => {
  test("creates the block for a bare note", () => {
    expect(setTemplateMarker("# T\n\nbody\n", true)).toBe("---\ntemplate: true\n---\n# T\n\nbody\n");
  });

  test("appends at the end of an existing block", () => {
    expect(setTemplateMarker("---\ncwd: ~/proj\n---\n# T\n", true)).toBe(
      "---\ncwd: ~/proj\ntemplate: true\n---\n# T\n",
    );
  });

  test("lands after an env: map without splitting it", () => {
    const marked = setTemplateMarker("---\nenv:\n  A: 1\n---\n# T\n", true);
    expect(marked).toBe("---\nenv:\n  A: 1\ntemplate: true\n---\n# T\n");
  });

  test("on is idempotent; a template: false line is replaced, not joined", () => {
    const marked = "---\ntemplate: true\n---\n# T\n";
    expect(setTemplateMarker(marked, true)).toBe(marked);
    expect(setTemplateMarker("---\ntemplate: false\n---\n# T\n", true)).toBe(marked);
    // A daily-role note is already a template: "make this a template" must
    // not demote it to a plain one.
    const daily = "---\ntemplate: daily\n---\n# T\n";
    expect(setTemplateMarker(daily, true)).toBe(daily);
  });

  test("off round-trips a marked bare note to its original bytes", () => {
    const text = "# T\n\nbody\n";
    expect(setTemplateMarker(setTemplateMarker(text, true), false)).toBe(text);
  });
});

describe("instantiateTemplate", () => {
  test("the marker never reaches an instance — with or without siblings", () => {
    expect(instantiateTemplate("---\ntemplate: true\n---\n# Meeting\n\nbody\n", "Untitled", NOW)).toBe(
      "# Untitled\n\nbody\n",
    );
    expect(
      instantiateTemplate("---\ntags: journal\ntemplate: true\n---\n# Meeting\n\nbody\n", "Untitled", NOW),
    ).toBe("---\ntags: journal\n---\n# Untitled\n\nbody\n");
  });

  test("substitutes then forces the title in one move", () => {
    const template = "# Daily Template\n\nStarted {{time}} on {{date}}.\n";
    expect(instantiateTemplate(template, "2026-07-18", NOW)).toBe(
      "# 2026-07-18\n\nStarted 23:30 on 2026-07-18.\n",
    );
  });

  test("a '# {{title}}' template needs no forcing", () => {
    expect(instantiateTemplate("# {{title}}\n\nbody\n", "My Note", NOW)).toBe(
      "# My Note\n\nbody\n",
    );
  });

  test("a '# {{date}}' daily template titles itself", () => {
    expect(instantiateTemplate("# {{date}}\n\n- [ ] review\n", "2026-07-18", NOW)).toBe(
      "# 2026-07-18\n\n- [ ] review\n",
    );
  });

  test("frontmatter and prompt fences arrive intact", () => {
    const template =
      "---\ncwd: ~/proj\ntags: journal\n---\n\n# Daily Template\n\n```prompt\nCarry over open tasks from [[{{yesterday}}]].\n```\n";
    expect(instantiateTemplate(template, "2026-07-18", NOW)).toBe(
      "---\ncwd: ~/proj\ntags: journal\n---\n\n# 2026-07-18\n\n```prompt\nCarry over open tasks from [[2026-07-17]].\n```\n",
    );
  });
});
