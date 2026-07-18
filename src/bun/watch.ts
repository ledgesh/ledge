// Per-root filesystem watching: the push half of external-edit safety.
//
// One recursive fs.watch per AVAILABLE workspace root. Events are filtered to
// what could change a note list or an open note (.md entries outside
// dot-directories), debounced per root, and surfaced as one "this root
// changed" callback — the view re-reads lists and reloads clean open buffers;
// nothing here says WHAT changed, because the view's answer to any change is
// the same cheap re-read either way. Ledge's own saves fire events like
// anyone else's; the view's mtime comparison makes those a no-op, which is
// simpler and safer than teaching the watcher whose writes are whose.
//
// Failure posture matches the registry's (architecture.md §3): a root that
// cannot be watched (an unmounted external volume) is skipped with a warning,
// not failed — the window-focus refresh remains the belt for it, and the next
// syncWatchers call (a workspace change, or the next boot) retries.
import { watch, type FSWatcher } from "node:fs";

// Debounce long enough to swallow a burst (git checkout, an agent rewriting a
// file as temp+rename) into one refresh, short enough that an edit made in the
// note's own terminal drawer shows up while you look.
const DEBOUNCE_MS = 250;

// Does this event name something that could be (or hide) a note?
//
// The last segment must CONTAIN ".md", not end with it, because of how this
// platform reports a temp-plus-rename save — the very shape Ledge's own saves
// and most atomic-writing agents use: the probe shows the burst coalescing
// into ONE event named for the dotted temp file (".plan.md.tmp-123-1"), with
// no separate event under the target name. The temp name embeds the note's
// name, so matching ".md" anywhere in it is what keeps those saves visible;
// requiring a trailing ".md" made the watcher blind to exactly the writes it
// exists for (the fs test on the rename choreography is the regression net).
//
// Dotted DIRECTORY segments are still dropped: .git churn (constant while an
// agent works in an attached project folder), .ledge-trash's internal moves
// (a delete already fires under its source name in the root), editor state
// dirs. The filename can be null (events can coalesce past name attribution);
// count those, conservatively — a refresh too many is cheap, a missed one is
// stale UI. Everything else non-.md cannot appear in any list the view shows.
export function relevantChange(filename: string | null): boolean {
  if (filename === null) return true;
  const segments = filename.split("/");
  if (segments.slice(0, -1).some((s) => s.startsWith("."))) return false;
  return /\.md(\.|$)/i.test(segments[segments.length - 1]!);
}

interface RootWatch {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, RootWatch>();

// Reconcile the watched set against the given roots: close what dropped out,
// open what is new, leave the rest running. Called at boot and again on every
// workspace attach/create/detach — the registry is the source of truth and
// this trails it.
export function syncWatchers(roots: string[], onChange: (root: string) => void): void {
  const want = new Set(roots);
  for (const [root, w] of watchers) {
    if (want.has(root)) continue;
    if (w.timer !== null) clearTimeout(w.timer);
    w.watcher.close();
    watchers.delete(root);
  }
  for (const root of want) {
    if (watchers.has(root)) continue;
    let entry: RootWatch;
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!relevantChange(filename)) return;
        if (entry.timer !== null) return; // trailing-edge debounce: one refresh per burst
        entry.timer = setTimeout(() => {
          entry.timer = null;
          onChange(root);
        }, DEBOUNCE_MS);
      });
      // A root that vanishes mid-session (volume unmounted) surfaces as an
      // error event; treat it as "stop watching" — the focus refresh takes
      // over, and a re-sync after remount starts a fresh watcher.
      watcher.on("error", (err) => {
        console.warn("[watch] watcher for", root, "failed; falling back to focus refresh:", err);
        const w = watchers.get(root);
        if (w?.watcher === watcher) {
          if (w.timer !== null) clearTimeout(w.timer);
          watchers.delete(root);
        }
        watcher.close();
      });
      entry = { watcher, timer: null };
      watchers.set(root, entry);
    } catch (err) {
      console.warn("[watch] could not watch", root, "(unmounted volume?):", err);
    }
  }
}

// Test seam: tear every watcher down so a test run leaves no timers or fds.
export function closeWatchers(): void {
  syncWatchers([], () => {});
}
