// One app process per client home (remote.md §8a). A second launch asks the
// running one to raise its window and exits. The lock is a listening socket,
// which the operating system frees when its holder dies: a named pipe on
// Windows, a socket file in the client home elsewhere.
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** The line a second launch sends, and the holder's answer. */
export const RAISE = "raise\n";
export const RAISED = "ok\n";

/**
 * Where the lock lives for the client home `clientHome`. A named pipe is
 * machine-wide rather than per user, so its name carries a hash of the
 * client home, which is per user and per scratch `LEDGE_NOTES_ROOT`.
 */
export function instanceAddress(clientHome: string, platform: string = process.platform): string {
  if (platform !== "win32") return join(clientHome, "app.sock");
  return `\\\\.\\pipe\\ledge-app-${Bun.hash(clientHome.toLowerCase()).toString(16)}`;
}

/** What a second launch heard: the holder raised its window, nothing is
 * listening there, or something holds the address and does not answer. */
export type Asked = "raised" | "nobody" | "silent";

/** Asks the process at `address` to raise its window. */
export async function askToRaise(address: string, timeoutMs: number): Promise<Asked> {
  let settle!: (a: Asked) => void;
  const answer = new Promise<Asked>((resolve) => (settle = resolve));
  let heard = "";
  const timer = setTimeout(() => settle("silent"), timeoutMs);
  try {
    const socket = await Bun.connect<undefined>({
      unix: address,
      socket: {
        data(s, chunk) {
          heard += chunk.toString();
          if (heard.includes(RAISED)) {
            settle("raised");
            s.end();
          }
        },
        close: () => settle("silent"),
        error: () => settle("silent"),
      },
    });
    socket.write(RAISE);
  } catch {
    settle("nobody");
  }
  const result = await answer;
  clearTimeout(timer);
  return result;
}

export interface Holder {
  /** Stops listening. The process exiting does the same. */
  release(): void;
}

/** Listens at `address`, answering each RAISE by calling `onRaise`. Throws
 * EADDRINUSE when another process holds it. */
export function holdAddress(address: string, onRaise: () => void): Holder {
  const listener = Bun.listen<{ heard: string }>({
    unix: address,
    socket: {
      open(s) {
        s.data = { heard: "" };
      },
      data(s, chunk) {
        s.data.heard += chunk.toString();
        if (!s.data.heard.includes(RAISE)) return;
        try {
          onRaise();
        } catch (err) {
          console.error("[instance] raising the window failed:", err);
        }
        s.write(RAISED);
        s.end();
      },
    },
  });
  if (address.startsWith("\\\\.\\pipe\\")) return { release: () => listener.stop(true) };
  // Anyone who can connect can only raise a window, but the socket file still
  // gets the client home's privacy.
  try {
    chmodSync(address, 0o600);
  } catch {
    // A socket nobody else can reach is a nicety, not a reason to refuse.
  }
  // A socket file outlives its process, and the next launch would spend two
  // asks finding it stale. Removed only while it is still this listener's.
  const ino = inodeOf(address);
  const unlink = () => {
    try {
      if (ino !== null && inodeOf(address) === ino) unlinkSync(address);
    } catch {
      // Already gone, which is all this was for.
    }
  };
  process.on("exit", unlink);
  return {
    release: () => {
      listener.stop(true);
      process.off("exit", unlink);
      unlink();
    },
  };
}

function inodeOf(path: string): number | null {
  try {
    return lstatSync(path).ino;
  } catch {
    return null;
  }
}

export type Claim = { held: true; holder: Holder } | { held: false; answered: boolean };

export interface ClaimOpts {
  onRaise(): void;
  /** How long to keep trying while the holder does not answer: a process
   * that is still exiting, or one that is wedged. */
  waitMs?: number;
  askMs?: number;
}

/**
 * Become this client home's one app process, or hand over to the one that is.
 *
 * `{ held: false, answered: true }` means the running app raised its window
 * and this launch should exit. `answered: false` means something held the
 * address for `waitMs` without answering.
 */
export async function claimInstance(address: string, opts: ClaimOpts): Promise<Claim> {
  const deadline = Date.now() + (opts.waitMs ?? 5_000);
  const askMs = opts.askMs ?? 1_000;
  for (;;) {
    try {
      return { held: true, holder: holdAddress(address, opts.onRaise) };
    } catch (err) {
      // EEXIST is what a listen racing another one for the same file can get.
      const code = (err as { code?: string }).code;
      if (code !== "EADDRINUSE" && code !== "EEXIST") throw err;
    }
    const asked = await askToRaise(address, askMs);
    if (asked === "raised") return { held: false, answered: true };
    // A socket file left by a process that died: nothing answers at it, and it
    // is in the way of the listen above. Asked twice, because a launch racing
    // this one refuses connections for an instant between its bind and its
    // listen. A named pipe goes with its holder and is never cleared.
    if (asked === "nobody" && (await Bun.sleep(100), await askToRaise(address, askMs)) === "nobody" && clearStale(address)) continue;
    if (Date.now() >= deadline) return { held: false, answered: false };
    await Bun.sleep(200);
  }
}

/** Removes the socket file at `address`. False when there is none to remove,
 * or it is not a socket. */
function clearStale(address: string): boolean {
  try {
    if (!lstatSync(address).isSocket()) return false;
    unlinkSync(address);
    return true;
  } catch {
    return false;
  }
}
