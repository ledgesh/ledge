// The view end of the vault RPC (note locking, locking.md), plus the one
// piece of vault state the view holds: the CURRENT VaultState, mirrored from
// Bun. Mirrored, not owned — Bun's key-in-memory is the truth; this cache is
// what lets the lock glyphs, the placeholder faces, and the two-faces palette
// commands render without a round trip. It updates from exactly two sources:
// each RPC's own response, and the vaultChanged push (which also covers the
// idle auto-relock the view never asked for).
//
// The channel shape is notes/channel.ts's: a configureX seam main.tsx wires,
// so everything here is testable without a webview.
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

// "locked" is the safe boot default: with no vault it is briefly wrong in the
// invisible direction (nothing is locked, so nothing renders differently)
// until the boot fetch lands.
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

/** Feed of Bun's vaultChanged push; also called with each RPC's own answer.
 * main.tsx wires the push; tests drive it directly. */
export function recordVaultState(state: VaultState): void {
  setState(state);
}

// --- operations --------------------------------------------------------------

export async function refreshVaultState(): Promise<VaultState> {
  const state = await bridge().state();
  setState(state);
  return state;
}

/** First lock ever: create the vault (leaves it unlocked). False = refused
 * (a vault already exists — the caller should be in the unlock flow). */
export async function createVault(passphrase: string): Promise<boolean> {
  const ok = await bridge().create(passphrase);
  if (ok) setState("unlocked");
  return ok;
}

/** False is a wrong passphrase — the dialog shakes and stays. */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const ok = await bridge().unlock(passphrase);
  if (ok) setState("unlocked");
  return ok;
}

/** Relock. The CALLER flushes dirty locked buffers first (editorPool's ⌘L
 * path does); Bun only drops keys. */
export async function lockVault(): Promise<void> {
  await bridge().lock();
  setState(vaultStateAfterLock());
}

// After a lock the vault necessarily EXISTS, so the state is "locked", never
// "none" — spelled as a function so the intent survives refactors.
function vaultStateAfterLock(): VaultState {
  return "locked";
}

export function lockNote(path: string): Promise<{ note: NoteMeta; sealedShared: string[] }> {
  return bridge().lockNote(path);
}

export function removeNoteLock(path: string): Promise<NoteMeta> {
  return bridge().removeLock(path);
}

/** Rewrap every locked note and sealed image under a new passphrase
 * (unlocked only; Bun sweeps, locking.md §3). */
export function changeVaultPassphrase(passphrase: string): Promise<{ ok: boolean; rewrapped: number }> {
  return bridge().changePassphrase(passphrase);
}

// The note-op wrappers the commands use: perform the transition, then nudge
// the folder's lists and open buffers through the SAME notesChanged path an
// external edit takes — the state change on disk (the stamped header, the
// sealed body) reaches the sidebar glyphs and the open editor with no second
// mechanism. In the real app the watcher fires too; a double refresh no-ops.
// `notice` carries the shared-image fact the lock surfaced (rpc noteLock's
// sealedShared), for the browser's notice strip.
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
