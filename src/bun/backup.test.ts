// The backup set's rules. Pure: no filesystem, no registry, no server — the
// input is what a machine's registry says and the output is two lists of
// paths, which is the whole of what `backup-paths` decides (testing.md §2).
import { expect, test } from "bun:test";
import { backupSet } from "./backup";

const HOME = "/srv/ledge";
const PROFILES = "/root/.config/ledge/profiles";

function set(over: Partial<Parameters<typeof backupSet>[0]> = {}) {
  return backupSet({ appHome: HOME, profilesDir: PROFILES, roots: [], secrets: true, ...over });
}

test("the app home is included whole, so new state in it is backed up by default", () => {
  expect(set().include).toContain(HOME);
});

test("profiles are included even though they live outside the app home", () => {
  // The bug this module exists for: notes that say `profile: prod` restore
  // without the values unless this path travels with them.
  expect(set().include).toContain(PROFILES);
});

test("--no-secrets drops the profiles dir and nothing else", () => {
  const withOut = set({ secrets: false });
  expect(withOut.include).not.toContain(PROFILES);
  expect(withOut.include).toEqual(set().include.filter((p) => p !== PROFILES));
});

test("external roots are included; managed roots are not, being inside the app home", () => {
  const { include } = set({ roots: [`${HOME}/scratch`, "/mnt/work/notes"] });
  expect(include).toContain("/mnt/work/notes");
  expect(include).not.toContain(`${HOME}/scratch`);
});

test("the docs root is not included: it is inside the app home and then excluded", () => {
  const { include, exclude } = set({ roots: [`${HOME}/.ledge-docs`] });
  expect(include).not.toContain(`${HOME}/.ledge-docs`);
  expect(exclude).toContain(`${HOME}/.ledge-docs`);
});

test("the socket, the pidfile and the logs are excluded", () => {
  expect(set().exclude).toEqual([
    `${HOME}/.server.sock`,
    `${HOME}/.server.pid`,
    `${HOME}/logs`,
    `${HOME}/.ledge-docs`,
  ]);
});

test("a root repeated in the registry is included once", () => {
  const { include } = set({ roots: ["/mnt/work/notes", "/mnt/work/notes"] });
  expect(include.filter((p) => p === "/mnt/work/notes")).toHaveLength(1);
});

test("a profiles dir already covered by a root is not added twice", () => {
  // LEDGE_PROFILES_DIR can point anywhere, including inside a root. Naming a
  // path twice makes restic walk it twice.
  const { include } = set({ roots: ["/mnt/work"], profilesDir: "/mnt/work/secrets" });
  expect(include).not.toContain("/mnt/work/secrets");
  expect(include).toContain("/mnt/work");
});

test("a profiles dir inside the app home is covered by it, not repeated", () => {
  const { include } = set({ profilesDir: `${HOME}/.profiles` });
  expect(include).toEqual([HOME]);
});
