// The built-in documentation corpus, compiled INTO the binary as text imports
// rather than shipped as loose files: the bundle then needs no build.copy
// entry, and dev and packaged runs resolve the pages identically (no
// import.meta.dir gymnastics against two different bundle layouts). The
// authored sources live in docs/user/ as ordinary Markdown; adding a page is
// one import plus one manifest line, and bun/docs.ts syncs the manifest into
// ~/.ledge/.ledge-docs at every launch.
//
// Filenames are stated here, not derived from the H1 like a user note's:
// these files are machine-written artifacts (the sync compares and prunes by
// exactly these names), and the source file in docs/user/ should keep the
// same name so grep finds both ends. The numeric prefix IS the reading
// order: the note browser sorts the docs workspace by path (NoteBrowser.tsx),
// so the manifest's numbering decides how the manual reads top to bottom —
// titles stay clean, and renumbering is just a rename the sync absorbs.
//
// Authoring rules: one line per paragraph, no hard wrapping (these pages
// render in the editor, which soft-wraps; an 80-column wrap, the style of
// the repo docs next door, shows up as broken lines mid-sentence) — and no
// em dashes in the prose.
import gettingStarted from "../../docs/user/01-getting-started.md" with { type: "text" };
import runningCode from "../../docs/user/02-running-code.md" with { type: "text" };
import notesAndWorkspaces from "../../docs/user/03-notes-and-workspaces.md" with { type: "text" };
import findingThings from "../../docs/user/04-finding-things.md" with { type: "text" };
import frontmatterEnvs from "../../docs/user/05-frontmatter-and-environments.md" with { type: "text" };
import profilesSecrets from "../../docs/user/06-profiles-and-secrets.md" with { type: "text" };
import remoteHosts from "../../docs/user/07-remote-hosts.md" with { type: "text" };
import dailyTemplates from "../../docs/user/08-daily-notes-and-templates.md" with { type: "text" };
import images from "../../docs/user/09-images.md" with { type: "text" };
import noteLocking from "../../docs/user/10-note-locking.md" with { type: "text" };
import agents from "../../docs/user/11-agents-and-ledge.md" with { type: "text" };
import cli from "../../docs/user/12-the-ledge-cli.md" with { type: "text" };
import tutorialProject from "../../docs/user/13-tutorial-run-a-project.md" with { type: "text" };
import tutorialDaily from "../../docs/user/14-tutorial-a-daily-workflow.md" with { type: "text" };
import tutorialAgent from "../../docs/user/15-tutorial-pair-with-an-agent.md" with { type: "text" };
import tutorialSync from "../../docs/user/16-tutorial-keep-notes-synced.md" with { type: "text" };

export interface DocPage {
  /** The .md filename inside the docs root. */
  name: string;
  text: string;
}

export const DOC_PAGES: DocPage[] = [
  { name: "01-getting-started.md", text: gettingStarted },
  { name: "02-running-code.md", text: runningCode },
  { name: "03-notes-and-workspaces.md", text: notesAndWorkspaces },
  { name: "04-finding-things.md", text: findingThings },
  { name: "05-frontmatter-and-environments.md", text: frontmatterEnvs },
  { name: "06-profiles-and-secrets.md", text: profilesSecrets },
  { name: "07-remote-hosts.md", text: remoteHosts },
  { name: "08-daily-notes-and-templates.md", text: dailyTemplates },
  { name: "09-images.md", text: images },
  { name: "10-note-locking.md", text: noteLocking },
  { name: "11-agents-and-ledge.md", text: agents },
  { name: "12-the-ledge-cli.md", text: cli },
  { name: "13-tutorial-run-a-project.md", text: tutorialProject },
  { name: "14-tutorial-a-daily-workflow.md", text: tutorialDaily },
  { name: "15-tutorial-pair-with-an-agent.md", text: tutorialAgent },
  { name: "16-tutorial-keep-notes-synced.md", text: tutorialSync },
];
