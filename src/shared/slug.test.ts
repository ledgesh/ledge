import { describe, expect, test } from "bun:test";
import { headingOf, labelOf, slugOf, slugify, titleOf } from "./slug";

describe("headingOf", () => {
  test("takes a first-line H1", () => {
    expect(headingOf("# Shipping Notes\n\nbody")).toBe("Shipping Notes");
  });

  test("a single-line note with nothing but a heading still has one", () => {
    expect(headingOf("# Alone")).toBe("Alone");
  });

  test("trailing whitespace and closing hashes-free text are trimmed", () => {
    expect(headingOf("#   Spaced   \nbody")).toBe("Spaced");
  });

  test("only the FIRST line counts", () => {
    // A note whose heading is further down is not titled by it: the rule has to
    // be something you can see without scrolling.
    expect(headingOf("some prose\n# Later Heading")).toBeNull();
    expect(headingOf("\n# After a blank line")).toBeNull();
  });

  test("only an H1 counts, not deeper headings", () => {
    expect(headingOf("## Subheading\nbody")).toBeNull();
    expect(headingOf("### Deeper\nbody")).toBeNull();
  });

  test("a # without whitespace is not a heading", () => {
    // CommonMark agrees, and it keeps "#hashtag" from naming a note.
    expect(headingOf("#hashtag\nbody")).toBeNull();
  });

  test("an empty heading is not a heading", () => {
    expect(headingOf("#\nbody")).toBeNull();
    expect(headingOf("#   \nbody")).toBeNull();
  });

  test("a note that opens with prose has no heading", () => {
    expect(headingOf("just some text\n")).toBeNull();
    expect(headingOf("")).toBeNull();
  });
});

describe("headingOf and frontmatter", () => {
  test("the title is the first line after the block", () => {
    expect(headingOf("---\ncwd: /x\n---\n# Shipping Notes\nbody")).toBe("Shipping Notes");
  });

  test("the conventional blank line under the fence does not cost the title", () => {
    // Every frontmatter-bearing tool trains this habit; strict-first-line here
    // would rename the note to untitled for leaving one blank line.
    expect(headingOf("---\ncwd: /x\n---\n\n# Shipping Notes\nbody")).toBe("Shipping Notes");
    expect(headingOf("---\ncwd: /x\n---\n\n\n# Spaced Out\n")).toBe("Spaced Out");
  });

  test("a bare note keeps the strict first-line rule", () => {
    // Without a fence, the blank first line still means "opens with something
    // other than a heading" — frontmatter loosens nothing for plain notes.
    expect(headingOf("\n# After a blank line")).toBeNull();
  });

  test("prose after the block still is not a heading", () => {
    expect(headingOf("---\ncwd: /x\n---\nprose\n# Later")).toBeNull();
  });

  test("a note that is only frontmatter has no heading", () => {
    expect(headingOf("---\ncwd: /x\n---\n")).toBeNull();
    expect(headingOf("---\ncwd: /x\n---")).toBeNull();
  });

  test("an unterminated opener is content, so its --- first line is no heading", () => {
    expect(headingOf("---\n# Not A Title Behind A Thematic Break\n")).toBeNull();
  });

  test("slugOf composes: a frontmatter note is named by its real heading", () => {
    expect(slugOf("---\nprofile: petstore\n---\n# API Smoke Tests\n")).toBe("api-smoke-tests");
    expect(slugOf("---\nprofile: petstore\n---\nno heading\n")).toBeNull();
  });
});

describe("slugify", () => {
  test("lowercases and hyphenates", () => {
    expect(slugify("Shipping Notes")).toBe("shipping-notes");
  });

  test("punctuation collapses into single separators", () => {
    expect(slugify("What's new: v1.2 (draft!)")).toBe("what-s-new-v1-2-draft");
  });

  test("leading and trailing separators are trimmed", () => {
    expect(slugify("  ...Hello!!!  ")).toBe("hello");
  });

  test("accents fold to their base letters rather than shredding the word", () => {
    expect(slugify("Café Menu")).toBe("cafe-menu");
    expect(slugify("naïve résumé")).toBe("naive-resume");
  });

  test("a heading with nothing sluggable is refused", () => {
    // The caller falls back to the enumerated "untitled" name.
    expect(slugify("!!!")).toBeNull();
    expect(slugify("   ")).toBeNull();
    expect(slugify("日本語")).toBeNull();
  });

  test("the slug is safe by construction: no dots, separators, or leading dot", () => {
    expect(slugify("../../.ssh/authorized_keys")).toBe("ssh-authorized-keys");
    expect(slugify(".hidden")).toBe("hidden");
    expect(slugify("a/b\\c:d")).toBe("a-b-c-d");
    expect(slugify("notes.md")).toBe("notes-md");
  });

  test("a long heading is truncated on a word boundary", () => {
    const slug = slugify("The Quick Brown Fox Jumps Over The Lazy Dog And Keeps On Running Forever")!;
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    // Cut between words, so the last word is whole rather than sliced mid-letter.
    expect(slug).toBe("the-quick-brown-fox-jumps-over-the-lazy-dog-and-keeps-on");
  });

  test("a long single word is truncated even with no boundary to cut on", () => {
    const slug = slugify("a".repeat(200))!;
    expect(slug).toBe("a".repeat(60));
  });
});

describe("slugOf", () => {
  test("a titled note asks for its heading's slug", () => {
    expect(slugOf("# Shipping Notes\n\nbody")).toBe("shipping-notes");
  });

  test("an untitled note asks for nothing", () => {
    expect(slugOf("just prose\n")).toBeNull();
    expect(slugOf("## Sub\n")).toBeNull();
  });

  test("a heading that slugs to nothing asks for nothing", () => {
    expect(slugOf("# ???\n")).toBeNull();
  });
});

describe("labelOf", () => {
  test("a note with a heading is called by it", () => {
    expect(labelOf("Shipping Notes", "/notes/shipping-notes.md")).toBe("Shipping Notes");
  });

  test("a note with no heading falls back to its filename", () => {
    // Deleting an H1 does not rename the file, so shipping-notes.md really is
    // still "shipping-notes". Saying so beats showing "Untitled", which would be
    // wrong AND identical for every de-titled note in the list.
    expect(labelOf(null, "/notes/shipping-notes.md")).toBe("shipping-notes");
  });

  test("a note with neither is Untitled", () => {
    // A new note that has not been typed in has no file and no heading.
    expect(labelOf(null, null)).toBe("Untitled");
  });

  test("a heading wins even for a note with no file yet", () => {
    expect(labelOf("Fresh Thought", null)).toBe("Fresh Thought");
  });

  test("the label is the heading verbatim, not its slug", () => {
    // The whole point: the file is shipping-notes.md, the label is not.
    expect(labelOf("Shipping Notes: v1.2!", "/notes/shipping-notes-v1-2.md")).toBe("Shipping Notes: v1.2!");
  });
});

describe("labelOf caps a runaway heading", () => {
  test("a normal heading is passed through untouched", () => {
    const h = "A Perfectly Reasonable Heading That Is Somewhat Long But Fine";
    expect(labelOf(h, "/notes/x.md")).toBe(h);
  });

  test("a paragraph-length heading is truncated with an ellipsis", () => {
    // Nothing stops an H1 being a whole paragraph, and it would otherwise ride
    // through the store in full just to be clipped by CSS.
    const label = labelOf("word ".repeat(500), "/notes/x.md");
    expect(label.length).toBeLessThanOrEqual(124);
    expect(label.endsWith("...")).toBe(true);
    expect(label.startsWith("word word")).toBe(true);
  });
});

describe("titleOf", () => {
  test("drops the directory and the extension", () => {
    expect(titleOf("/Users/x/.ledge/shipping-notes.md")).toBe("shipping-notes");
  });

  test("keeps inner dots", () => {
    expect(titleOf("/Users/x/.ledge/v1.2.notes.md")).toBe("v1.2.notes");
  });
});
