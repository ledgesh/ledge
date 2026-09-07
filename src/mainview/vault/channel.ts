// The view end of the vault RPC (note locking, locking.md), plus the one piece
// of vault state the view holds: a mirror of the current VaultState. Bun's
// in-memory key is the truth. The mirror renders the lock glyphs and the
// placeholder faces without a round trip. It also decides which of the two
// palette lock commands is visible (registry.ts vault.lock and vault.unlock).

// Exactly two things write the mirror: each RPC's own response, and the
// vaultChanged push. The push also covers the idle auto-relock, which the view
// never asked for. The shape follows notes/channel.ts: a configureX seam that
// boot.tsx wires. Everything here is testable without a webview.
import { useSyncExternalStore } from "react";
import type { VaultState } from "../../shared/rpc-schema";
import type { NoteMeta } from "../../shared/rpc-schema";
import { dispatchNotesChanged } from "../notes/channel";

interface VaultHandlers {
  state: () => Promise<VaultState>;
  create: (passphrase: string) => Promise<boolean>;
  unlock: (passphrase: string) => Promise<boolean>;
  lock: () => Promise<void>;
  lockNote: (path: string) => Promise<{ note: NoteMeta; sealedShared: string[] }>;
  removeLock: (path: string) => Promise<NoteMeta>;
  changePassphrase: (passphrase: string) => Promise<{ ok: boolean; rewrapped: number }>;
}

let handlers: VaultHandlers | null = null;

export function configureVault(h: VaultHandlers): void {
  handlers = h;
}

function bridge(): VaultHandlers {
  if (!handlers) throw new Error("vault bridge not configured");
  return handlers;
}

// --- the mirrored state ------------------------------------------------------

// "locked" is the boot default, until the boot fetch lands. Guessing
// "locked" is the fail-safe direction. On a machine with no vault the guess
// is wrong, and usually invisible: with nothing locked, nothing renders
// differently.
let current: VaultState = "locked";
const subs = new Set<() => void>();

function setState(next: VaultState): void {
  if (next === current) return;
  current = next;
  for (const fn of subs) fn();
}

export function vaultState(): VaultState {
  return current;
}

/** Subscribe outside React (the editor pool's placeholder faces). */
export function onVaultChanged(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** The React face of the same subscription (glyphs, dialogs, palette). */
export function useVaultState(): VaultState {
  return useSyncExternalStore(
    (fn) => onVaultChanged(fn),
    () => current,
  );
}

/** Sets the mirrored VaultState from outside this module. boot.tsx routes
 * Bun's vaultChanged push here. The test harness calls it with each RPC's own
 * answer (harness.tsx). */
export function recordVaultState(state: VaultState): void {
  setState(state);
}

// --- operations --------------------------------------------------------------

export async function refreshVaultState(): Promise<VaultState> {
  const state = await bridge().state();
  setState(state);
  return state;
}

/** Creates the vault from the first lock's passphrase and leaves it unlocked.
 * False means Bun refused (server.ts vaultCreate): a vault already exists, the
 * passphrase was empty, or the vault file did not write. When a vault already
 * exists the caller should be in the unlock flow. */
export async function createVault(passphrase: string): Promise<boolean> {
  const ok = await bridge().create(passphrase);
  if (ok) setState("unlocked");
  return ok;
}

/** Unlocks the vault. False is a wrong passphrase: the dialog shakes and
 * stays. */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const ok = await bridge().unlock(passphrase);
  if (ok) setState("unlocked");
  return ok;
}

/** Relocks the vault. The caller flushes dirty locked buffers first
 * (commands/glue.ts lockVaultNow does). Bun only drops keys (locking.md §3). */
export async function lockVault(): Promise<void> {
  await bridge().lock();
  setState(vaultStateAfterLock());
}

// After a lock the vault exists, so the state is "locked", never "none". A
// function rather than a literal, so a refactor cannot inline the constant and
// drop the reasoning with it.
function vaultStateAfterLock(): VaultState {
  return "locked";
}

export function lockNote(path: string): Promise<{ note: NoteMeta; sealedShared: string[] }> {
  return bridge().lockNote(path);
}

export function removeNoteLock(path: string): Promise<NoteMeta> {
  return bridge().removeLock(path);
}

/** Rewraps every locked note's header and every sealed image's key under a
 * new passphrase. The vault must be unlocked (locking.md §3). Bun sweeps
 * availableRoots(), not every registered root (server.ts
 * vaultChangePassphrase). A root whose volume is not mounted is skipped: its
 * locked notes keep the old wrap and open under neither passphrase until the
 * change is re-run with the volume mounted. */
export function changeVaultPassphrase(passphrase: string): Promise<{ ok: boolean; rewrapped: number }> {
  return bridge().changePassphrase(passphrase);
}

// The note-op wrappers the commands use. Each performs the transition, then
// dispatches notesChanged for the folder, the same path an external edit
// takes. The stamped header and sealed body on disk then reach the sidebar
// glyphs and the open editor, with no second mechanism. In the real app the
// watcher fires too, and the second refresh no-ops.

// `notice` names each image this lock also sealed and the other note that
// shows it (noteLock's sealedShared), for the note browser's notice strip.
export async function lockNoteAndRefresh(
  folder: string,
  path: string,
): Promise<{ error: string | null; notice: string | null }> {
  try {
    const res = await bridge().lockNote(path);
    dispatchNotesChanged(folder);
    return {
      error: null,
      notice:
        res.sealedShared.length > 0
          ? `Locked. Also sealed ${res.sealedShared.join(", ")}; those notes show it locked until an unlock.`
          : null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), notice: null };
  }
}

export async function removeLockAndRefresh(folder: string, path: string): Promise<string | null> {
  try {
    await bridge().removeLock(path);
    dispatchNotesChanged(folder);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
