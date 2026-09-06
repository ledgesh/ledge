// Per-root filesystem watching: the push half of external-edit safety.
//
// One recursive fs.watch per available workspace root. Events are filtered to
// what could change a note list or an open note (.md entries outside
// dot-directories), debounced per root, and reported as one "this root
// changed" callback. Nothing here says what changed: the view re-reads lists
// and reloads clean open buffers for any change. Ledge's own saves fire
// events too, and the mtime comparison in the view's reload makes those a
// no-op (mainview/workspace/editorPool.ts). Do not suppress them here
// instead: the watcher would have to work out whose write each event came
// from.
//
// A root that cannot be watched (an unmounted volume) is skipped with a
// warning rather than failing the sync, and the window-focus refresh is the
// belt for it (architecture.md §3). A later syncWatchers retries it.
import { watch, type FSWatcher } from "node:fs";

// The debounce window per root: long enough to swallow a burst (a git
// checkout, an agent rewriting a file as temp+rename) into one refresh, short
// enough that an edit made in the note's own terminal drawer shows up while
// the note is still on screen.
const DEBOUNCE_MS = 250;

// True when an event names something that could be (or hide) a note.
//
// The last segment must contain ".md" rather than end with it. A probe showed
// this platform reporting a temp-plus-rename save (the shape Ledge's own
// saves and most atomic-writing agents use) as one coalesced event named for
// the dotted temp file (".plan.md.tmp-123-1"), with no separate event under
// the target name. The temp name embeds the note's name, so matching ".md"
// anywhere in it keeps those saves visible. Requiring a trailing ".md" made
// the watcher blind to them. watch.fs.test.ts covers the rename choreography.
//
// Dotted directory segments are still dropped: .git churn (constant while an
// agent works in an attached project folder), .ledge-trash's internal moves
// (a delete already fires under its source name in the root), editor state
// directories. The view's lists hold only .md files.
//
// A null filename counts as relevant. Events can coalesce past name
// attribution. An extra refresh is cheap. A missed one leaves the UI stale.
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
// open what is new, leave the rest running. Called at boot and again from
// every handler that changes the registry (workspace create, attach, detach,
// move; server.ts refreshWatchers). The registry is the source of truth and
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
        // Trailing-edge debounce: the first event arms the timer below and
        // later ones return here. The refresh fires when the window ends.
        if (entry.timer !== null) return;
        entry.timer = setTimeout(() => {
          entry.timer = null;
          onChange(root);
        }, DEBOUNCE_MS);
      });
      // A root that vanishes mid-session (volume unmounted) surfaces as an
      // error event. Stop watching it: the focus refresh takes over, and a
      // re-sync after remount starts a fresh watcher.
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
