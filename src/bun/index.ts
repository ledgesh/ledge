// Ledge main process.
//
// One native window loads the editor webview. Two shells run in this Bun process
// via the bun:ffi PTY (a port of the Swift SessionKit core): the inline-run shell
// (block output sliced per block by OSC 133 markers) and the terminal-drawer
// shell (raw, driving xterm.js). Both talk to the view over typed RPC.
import { BrowserView, BrowserWindow, Updater } from "electrobun/bun";
import { PtyProcess } from "./pty";
import { MarkerParser, markerCommand } from "./markers";
import type { LedgeRPC } from "../shared/rpc-schema";

// In the dev channel, prefer a running Vite dev server (bun run dev:hmr) so the
// React view hot-reloads; otherwise load the built view copied into the bundle.
const VITE_URL = "http://localhost:5173";
async function mainViewUrl(): Promise<string> {
  if ((await Updater.localInfo.channel()) === "dev") {
    try {
      await fetch(VITE_URL, { method: "HEAD" });
      console.log("[bun] HMR: using Vite dev server at", VITE_URL);
      return VITE_URL;
    } catch {
      // Vite not running; fall through to the built view.
    }
  }
  return "views://mainview/index.html";
}

// Fresh per session, never written into a note, so a block cannot forge its own
// end marker (see markers.ts).
const NONCE = Math.random().toString(36).slice(2) + Date.now().toString(36);

const shellEnv = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;

// The inline-run shell: block bodies are sourced into it with OSC 133 markers so
// output can be sliced per block.
const shell = new PtyProcess({
  executable: "/bin/zsh",
  args: ["-i"],
  env: shellEnv,
  cwd: process.env["HOME"],
});
const parser = new MarkerParser(NONCE);

// The terminal drawer's shell: a separate, plain interactive session with no
// marker protocol. Its raw byte stream drives xterm.js in the view, and the
// view's keystrokes and resizes come back over the RPC below.
const term = new PtyProcess({
  executable: "/bin/zsh",
  args: ["-i"],
  env: shellEnv,
  cwd: process.env["HOME"],
});

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const fromB64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

// Terminal scrollback. The terminal shell prints its prompt at launch, long
// before the drawer is ever opened, so we keep a capped rolling buffer of its
// raw output and replay it when the view attaches. `attached` gates live
// streaming: bytes still accumulate while the drawer is closed, so re-opening
// replays the full history.
let attached = false;
const SB_CAP = 256 * 1024;
let sbChunks: Uint8Array[] = [];
let sbLen = 0;
function sbPush(d: Uint8Array): void {
  sbChunks.push(d);
  sbLen += d.length;
  while (sbLen > SB_CAP && sbChunks.length > 1) sbLen -= sbChunks.shift()!.length;
}
function sbSnapshot(): Uint8Array {
  const out = new Uint8Array(sbLen);
  let o = 0;
  for (const c of sbChunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const rpc = BrowserView.defineRPC<LedgeRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {
      runBlock: async ({ id, code }) => {
        // The block body goes to a file that we source, rather than being inlined
        // into the command line. That sidesteps quoting, heredocs, and line
        // continuations, and sourcing keeps cwd/env changes across blocks.
        const path = `/tmp/ledge-spike-${id}.sh`;
        await Bun.write(path, code);
        shell.write(markerCommand(`source ${path}`, NONCE, id));
        return { accepted: true };
      },
      terminalInput: ({ dataB64 }) => {
        term.write(fromB64(dataB64));
        return { ok: true };
      },
      terminalResize: ({ cols, rows }) => {
        term.resize(cols, rows);
        return { ok: true };
      },
      // Synchronous so no drain tick can interleave between the snapshot and
      // enabling live streaming: the snapshot is everything up to now, live is
      // everything after, with no gap or overlap.
      terminalAttach: () => {
        attached = true;
        return { dataB64: toB64(sbSnapshot()) };
      },
      terminalDetach: () => {
        attached = false;
        return { ok: true };
      },
      // System clipboard via macOS pbcopy/pbpaste. The webview cannot reach the
      // clipboard itself (non-secure views:// context), so the terminal and the
      // inline output panel proxy copy/paste through here.
      clipboardWrite: async ({ text }) => {
        try {
          const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
          p.stdin.write(text);
          await p.stdin.end();
          await p.exited;
        } catch {
          // No pbcopy (non-macOS or PATH issue); drop silently.
        }
        return { ok: true };
      },
      clipboardRead: async () => {
        try {
          const p = Bun.spawn(["pbpaste"], { stdout: "pipe" });
          const text = await new Response(p.stdout).text();
          await p.exited;
          return { text };
        } catch {
          return { text: "" };
        }
      },
    },
    messages: {},
  },
});

// Drain both shells on a short interval. (poll()-gated reads never block; see
// pty.ts.) The inline shell is sliced into per-block events; the terminal shell
// streams raw to the drawer.
setInterval(() => {
  const data = shell.drain();
  if (data) {
    for (const ev of parser.feed(data)) {
      if (ev.type === "began") {
        rpc.send.runEvent({ id: ev.blockId, kind: "began" });
      } else if (ev.type === "output") {
        rpc.send.runEvent({ id: ev.blockId, kind: "output", dataB64: toB64(ev.data) });
      } else if (ev.type === "ended") {
        rpc.send.runEvent({ id: ev.blockId, kind: "ended", exitCode: ev.exitCode });
      }
    }
  }

  const termData = term.drain();
  if (termData) {
    sbPush(termData);
    if (attached) rpc.send.terminalOutput({ dataB64: toB64(termData) });
  }
}, 8);

const mainWindow = new BrowserWindow({
  title: "Ledge",
  url: await mainViewUrl(),
  rpc,
  frame: { width: 940, height: 700, x: 200, y: 120 },
});

process.on("exit", () => {
  shell.close();
  term.close();
});

console.log("[bun] Ledge started, shell pid", shell.pid, "terminal pid", term.pid);
void mainWindow;

