// This app's own update, from the view's side (releasing.md §7). A configureX
// seam (architecture.md §5): boot.tsx binds the handlers to the update RPCs,
// harness.tsx binds stubs, and the command registry calls through here.
//
// The shell owns the update. The view mirrors its UpdateState, which decides
// what the menu and palette offer and which notice a change earns. Three things
// write the mirror: the boot read, a check's answer, and the updateChanged push.
import { useSyncExternalStore } from "react";
import type { UpdateState } from "../../shared/rpc-schema";

export interface UpdateHandlers {
  state(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  install(): Promise<boolean>;
}

export interface UpdateNotice {
  tone: "notice" | "error";
  message: string;
}

/** The mirrored state, and whether this window's Check for Updates… is still
 * waiting for its answer. */
export interface Mirror {
  state: UpdateState;
  asked: boolean;
}

/** Where a state came from: the boot read, the shell's push, or the answer to
 * this window's own check. */
export type Source = "boot" | "push" | "answer";

// --- pure core (unit-tested in updates.test.ts) -------------------------------

function notice(message: string): UpdateNotice {
  return { tone: "notice", message };
}

/**
 * The notice a change from `prev` to `next` earns, or null.
 *
 * `asked` is whether somebody chose Check for Updates… in this window and has
 * not had the answer yet. A background check's answer shows nothing, with one
 * exception: a ready update is announced whether anyone asked or not, since it
 * is the one outcome that waits on the user.
 */
export function updateNotice(prev: UpdateState, next: UpdateState, asked: boolean): UpdateNotice | null {
  if (next.phase === "ready") {
    if (prev.phase === "ready" && !asked) return null;
    return notice(`Ledge ${next.version} is ready. Choose Restart to Install Update in the Ledge menu.`);
  }
  if (!asked) return null;
  switch (next.phase) {
    case "idle":
    case "checking":
      return null;
    case "current":
      return notice(`Ledge ${next.version} is the latest version.`);
    case "downloading":
      return notice(`Downloading Ledge ${next.version}. Restart to Install Update appears in the Ledge menu when it finishes.`);
    case "failed":
      return { tone: "error", message: `Could not update Ledge: ${next.detail}` };
    case "off":
      return notice(next.detail);
  }
}

/**
 * The mirror after `next` arrives from `source`, and the notice it earns.
 *
 * An answer of "checking" is not recorded. That check reports through pushes,
 * which the shell sends before the answer, and an answer recorded after them
 * would put a finished check back to "checking". The boot read shows nothing:
 * a window opened while an update is ready still offers the verb, but only
 * the push that made it ready announces it.
 */
export function step(mirror: Mirror, next: UpdateState, source: Source): { mirror: Mirror; notice: UpdateNotice | null } {
  if (source === "answer" && next.phase === "checking") return { mirror, notice: null };
  const shown = source === "boot" ? null : updateNotice(mirror.state, next, mirror.asked);
  const answered = next.phase !== "checking" && next.phase !== "idle";
  return { mirror: { state: next, asked: mirror.asked && !answered }, notice: shown };
}

/** What a Restart to Install Update that did not start says. `state` is the
 * mirror after it, which the shell's push has already moved to "failed". */
export function installNotice(ok: boolean, state: UpdateState): UpdateNotice | null {
  if (ok) return null;
  return { tone: "error", message: `Could not install the update${state.detail ? `: ${state.detail}` : "."}` };
}

/** Whether Check for Updates… is offered: this app updates, and no update is
 * waiting to be installed (that face is Restart to Install Update). */
export function offersCheck(state: UpdateState): boolean {
  return state.phase !== "off" && state.phase !== "ready";
}

// --- the seam and the mirror --------------------------------------------------

let handlers: UpdateHandlers | null = null;

export function configureUpdates(h: UpdateHandlers): void {
  handlers = h;
}

function bridge(): UpdateHandlers {
  if (!handlers) throw new Error("update bridge not configured");
  return handlers;
}

// "off" until the boot read lands, so the update verbs are absent rather than
// briefly offered on a client that turns out not to update.
let mirror: Mirror = { state: { phase: "off", version: "", detail: "" }, asked: false };
const subs = new Set<() => void>();
const noticeSubs = new Set<(n: UpdateNotice) => void>();

function apply(next: UpdateState, source: Source): void {
  const prev = mirror.state;
  const result = step(mirror, next, source);
  mirror = result.mirror;
  if (mirror.state !== prev) for (const fn of subs) fn();
  if (result.notice) for (const fn of noticeSubs) fn(result.notice);
}

export function updateState(): UpdateState {
  return mirror.state;
}

/** Subscribe outside React. */
export function onUpdateChanged(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** The React face of the same subscription (the menu bar's re-push). */
export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (fn) => onUpdateChanged(fn),
    () => mirror.state,
  );
}

/** Every notice an update change earns, for the window's notice strip. */
export function onUpdateNotice(fn: (n: UpdateNotice) => void): () => void {
  noticeSubs.add(fn);
  return () => noticeSubs.delete(fn);
}

/** The shell's updateChanged push. boot.tsx routes it here, and the harness
 * calls it to play the shell's part. */
export function recordUpdateState(state: UpdateState): void {
  apply(state, "push");
}

/** The boot read. Not awaited by boot: the verbs appear when it lands. */
export function loadUpdateState(): Promise<void> {
  return bridge()
    .state()
    .then((state) => apply(state, "boot"));
}

/** Check for Updates…. The answer, and any notice it earns, arrive through the
 * mirror. */
export function checkForUpdates(): void {
  mirror = { ...mirror, asked: true };
  void bridge()
    .check()
    .then(
      (state) => apply(state, "answer"),
      (err: unknown) => {
        mirror = { ...mirror, asked: false };
        const message = err instanceof Error ? err.message : String(err);
        for (const fn of noticeSubs) fn({ tone: "error", message: `Could not check for updates: ${message}` });
      },
    );
}

/** Restart to Install Update. Resolves to the notice to show when the install
 * did not start. When it did, the app is quitting and nothing resolves. */
export async function installUpdate(): Promise<UpdateNotice | null> {
  const ok = await bridge().install();
  return installNotice(ok, mirror.state);
}
