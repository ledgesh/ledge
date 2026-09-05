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
// Authoring rules live in docs/contributor/writing.md (style, headings,
// voice). The two mechanical ones that bite here: one line per paragraph, no
// hard wrapping (these pages render in the editor, which soft-wraps; an
// 80-column wrap, the style of the repo docs next door, shows up as broken
// lines mid-sentence) — and no em dashes in the prose.
import gettingStarted from "../../docs/user/01-getting-started.md" with { type: "text" };
import runningCode from "../../docs/user/02-running-code.md" with { type: "text" };
import notesAndWorkspaces from "../../docs/user/03-notes-and-workspaces.md" with { type: "text" };
import panesAndTabs from "../../docs/user/04-panes-and-tabs.md" with { type: "text" };
import findingThings from "../../docs/user/05-finding-things.md" with { type: "text" };
import frontmatterEnvs from "../../docs/user/06-frontmatter-and-environments.md" with { type: "text" };
import profilesSecrets from "../../docs/user/07-profiles-and-secrets.md" with { type: "text" };
import remoteHosts from "../../docs/user/08-remote-hosts.md" with { type: "text" };
import dailyTemplates from "../../docs/user/09-daily-notes-and-templates.md" with { type: "text" };
import images from "../../docs/user/10-images.md" with { type: "text" };
import noteLocking from "../../docs/user/11-note-locking.md" with { type: "text" };
import agents from "../../docs/user/12-agents-and-ledge.md" with { type: "text" };
import cli from "../../docs/user/13-the-ledge-cli.md" with { type: "text" };
import tutorialProject from "../../docs/user/14-tutorial-run-a-project.md" with { type: "text" };
import tutorialDaily from "../../docs/user/15-tutorial-a-daily-workflow.md" with { type: "text" };
import tutorialAgent from "../../docs/user/16-tutorial-pair-with-an-agent.md" with { type: "text" };
import tutorialSync from "../../docs/user/17-tutorial-keep-notes-synced.md" with { type: "text" };
import anotherMachine from "../../docs/user/18-notes-on-another-machine.md" with { type: "text" };
import onYourPhone from "../../docs/user/19-ledge-on-your-phone.md" with { type: "text" };
// The one page not authored in docs/user/, and not authored at all: `bun run
// licenses` generates it (src/bun/licenses.ts) and writes it to the repository
// root, where GitHub, a packager, and anyone auditing the release all expect
// to find it. It is a page of the manual regardless of where its source sits,
// because the licenses it reproduces ask to travel with the app rather than
// stay behind in a repository. Editing it by hand is pointless: the next
// regeneration overwrites it, and licenses.test.ts fails in the meantime.
import thirdParty from "../../THIRD-PARTY-NOTICES.md" with { type: "text" };

export interface DocPage {
  /** The .md filename inside the docs root. */
  name: string;
  text: string;
}

export const DOC_PAGES: DocPage[] = [
  { name: "01-getting-started.md", text: gettingStarted },
  { name: "02-running-code.md", text: runningCode },
  { name: "03-notes-and-workspaces.md", text: notesAndWorkspaces },
  { name: "04-panes-and-tabs.md", text: panesAndTabs },
  { name: "05-finding-things.md", text: findingThings },
  { name: "06-frontmatter-and-environments.md", text: frontmatterEnvs },
  { name: "07-profiles-and-secrets.md", text: profilesSecrets },
  { name: "08-remote-hosts.md", text: remoteHosts },
  { name: "09-daily-notes-and-templates.md", text: dailyTemplates },
  { name: "10-images.md", text: images },
  { name: "11-note-locking.md", text: noteLocking },
  { name: "12-agents-and-ledge.md", text: agents },
  { name: "13-the-ledge-cli.md", text: cli },
  { name: "14-tutorial-run-a-project.md", text: tutorialProject },
  { name: "15-tutorial-a-daily-workflow.md", text: tutorialDaily },
  { name: "16-tutorial-pair-with-an-agent.md", text: tutorialAgent },
  { name: "17-tutorial-keep-notes-synced.md", text: tutorialSync },
  { name: "18-notes-on-another-machine.md", text: anotherMachine },
  { name: "19-ledge-on-your-phone.md", text: onYourPhone },
  { name: "20-third-party-licenses.md", text: thirdParty },
];
