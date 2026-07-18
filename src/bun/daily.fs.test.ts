// daily.ts against a real filesystem: the create-or-open idempotency that IS
// the feature's promise, template instantiation with frontmatter carried, and
// the degradation paths. Same scratch-app-home discipline as notes.fs.test.ts.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { APP_HOME, createManaged, loadWorkspaces } from "./workspaces";
import { createNote, readNote } from "./notes";
import { createFromTemplate, createFromTemplatePath, findDailyTemplate, findTemplate, openDaily } from "./daily";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run filesystem tests against ${APP_HOME} — is the preload configured?`);
}

let ROOT = "";

// The fixed "today" every test uses: 2026-07-18, late evening — local, so the
// titles asserted below cannot depend on the machine's timezone.
const NOW = new Date(2026, 6, 18, 23, 30);

beforeEach(async () => {
  await rm(APP_HOME, { recursive: true, force: true });
  await mkdir(APP_HOME, { recursive: true });
  await loadWorkspaces();
  ROOT = await createManaged("Notes");
});

describe("openDaily", () => {
  test("creates a bare dated note when no template is configured", async () => {
    const { meta, created } = await openDaily(ROOT, NOW);
    expect(created).toBe(true);
    expect(meta.path).toBe(join(ROOT, "2026-07-18.md"));
    expect(meta.title).toBe("2026-07-18");
    expect((await readNote(meta.path))?.text).toBe("# 2026-07-18\n");
  });

  test("a second call the same day returns the same note and mints no -2", async () => {
    const first = await openDaily(ROOT, NOW);
    const second = await openDaily(ROOT, NOW);
    expect(second.created).toBe(false);
    expect(second.meta.path).toBe(first.meta.path);
    expect(await readNote(join(ROOT, "2026-07-18-2.md"))).toBeNull();
  });

  test("different days are different notes", async () => {
    await openDaily(ROOT, NOW);
    const tomorrow = await openDaily(ROOT, new Date(2026, 6, 19, 8, 0));
    expect(tomorrow.created).toBe(true);
    expect(tomorrow.meta.path).toBe(join(ROOT, "2026-07-19.md"));
  });

  test("instantiates the note marked template: daily, substituted and retitled — marker stripped", async () => {
    // No settings anywhere: the role is the note's own frontmatter.
    await createNote(
      ROOT,
      "---\ncwd: ~/proj\ntags: journal\ntemplate: daily\n---\n\n# Daily Template\n\nCarry over [[{{yesterday}}]].\n\n```prompt\nSummarize [[{{yesterday}}]].\n```\n",
    );
    const { meta } = await openDaily(ROOT, NOW);
    expect(meta.path).toBe(join(ROOT, "2026-07-18.md"));
    expect((await readNote(meta.path))?.text).toBe(
      "---\ncwd: ~/proj\ntags: journal\n---\n\n# 2026-07-18\n\nCarry over [[2026-07-17]].\n\n```prompt\nSummarize [[2026-07-17]].\n```\n",
    );
  });

  test("a plain template: true note is NOT the daily template", async () => {
    await createNote(ROOT, "---\ntemplate: true\n---\n# Meeting\n\nagenda\n");
    const { meta } = await openDaily(ROOT, NOW);
    expect((await readNote(meta.path))?.text).toBe("# 2026-07-18\n");
  });

  test("finds an existing daily note case-insensitively by title, wherever it sits", async () => {
    // A hand-made note in a subfolder still counts as today's: resolution is
    // by title over the listing, not by a fixed path.
    await mkdir(join(ROOT, "journal"), { recursive: true });
    const made = await createNote(ROOT, "# 2026-07-18\n\nalready here\n");
    const { meta, created } = await openDaily(ROOT, NOW);
    expect(created).toBe(false);
    expect(meta.path).toBe(made.path);
  });
});

describe("findTemplate / createFromTemplate", () => {
  test("prefers the target root's own template over another workspace's", async () => {
    const other = await createManaged("Other");
    await createNote(other, "# Meeting\n\ntheirs\n");
    await createNote(ROOT, "# Meeting\n\nours\n");
    const found = await findTemplate("Meeting", ROOT);
    expect(found?.text).toContain("ours");
  });

  test("falls back to other workspaces when the target root lacks the title", async () => {
    const other = await createManaged("Other");
    await createNote(other, "# Meeting\n\ntheirs\n");
    const note = await createFromTemplate(ROOT, "Meeting", "Standup", NOW);
    expect(note.path).toBe(join(ROOT, "standup.md"));
    expect((await readNote(note.path))?.text).toBe("# Standup\n\ntheirs\n");
  });

  test("a null title instantiates as Untitled, enumerable like any collision", async () => {
    await createNote(ROOT, "# Meeting\n\nagenda\n");
    const first = await createFromTemplate(ROOT, "Meeting", null, NOW);
    expect(first.path).toBe(join(ROOT, "untitled.md"));
    expect((await readNote(first.path))?.text).toBe("# Untitled\n\nagenda\n");
    const second = await createFromTemplate(ROOT, "Meeting", null, NOW);
    expect(second.path).toBe(join(ROOT, "untitled-2.md"));
  });

  test("findDailyTemplate is strictly per-workspace: no borrowing, several claimants resolve newest-first", async () => {
    const other = await createManaged("Other");
    await createNote(other, "---\ntemplate: daily\n---\n# Theirs\n\ntheirs\n");
    // Another workspace's claimant is NOT borrowed — a workspace without its
    // own daily template gets the bare dated note, never a template it cannot
    // see from where it sits.
    expect(await findDailyTemplate(ROOT)).toBeNull();
    expect((await readNote((await openDaily(ROOT, NOW)).meta.path))?.text).toBe("# 2026-07-18\n");
    await createNote(ROOT, "---\ntemplate: daily\n---\n# Ours Old\n\nours old\n");
    const newest = await createNote(ROOT, "---\ntemplate: daily\n---\n# Ours New\n\nours new\n");
    // Backdate the older claimant so newest-first is deterministic.
    await utimes(join(ROOT, "ours-old.md"), new Date(1_000_000), new Date(1_000_000));
    const found = await findDailyTemplate(ROOT);
    expect(found?.path).toBe(newest.path);
  });

  test("an explicitly named template that resolves to nothing throws", async () => {
    expect(createFromTemplate(ROOT, "Ghost", "T", NOW)).rejects.toThrow(
      'no note titled "Ghost" to use as a template',
    );
  });

  test("the template: true marker never reaches an instance", async () => {
    await createNote(ROOT, "---\ntags: work\ntemplate: true\n---\n# Meeting\n\nagenda\n");
    const note = await createFromTemplate(ROOT, "Meeting", "Standup", NOW);
    // The rest of the frontmatter carries; the marker is stripped, so the
    // instance does not show up in the template picker itself.
    expect((await readNote(note.path))?.text).toBe("---\ntags: work\n---\n# Standup\n\nagenda\n");
  });
});

describe("createFromTemplatePath", () => {
  test("instantiates the exact note the path names, even under a title tie", async () => {
    const other = await createManaged("Other");
    await createNote(ROOT, "---\ntemplate: true\n---\n# Meeting\n\nours\n");
    const theirs = await createNote(other, "---\ntemplate: true\n---\n# Meeting\n\ntheirs\n");
    // The picker chose the OTHER workspace's Meeting; title resolution would
    // have preferred ROOT's own — the path must win.
    const note = await createFromTemplatePath(ROOT, theirs.path, "Standup", NOW);
    expect(note.path).toBe(join(ROOT, "standup.md"));
    expect((await readNote(note.path))?.text).toBe("# Standup\n\ntheirs\n");
  });

  test("a vanished template throws; a path outside every root is refused", async () => {
    expect(createFromTemplatePath(ROOT, join(ROOT, "gone.md"), "T", NOW)).rejects.toThrow(
      /template note is gone/,
    );
    expect(createFromTemplatePath(ROOT, "/etc/passwd", "T", NOW)).rejects.toThrow(
      /outside every workspace root/,
    );
  });
});
