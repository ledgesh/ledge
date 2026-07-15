// Ledge main process (Electrobun spike).
//
// Proves the assembled architecture end to end: one native window loads the
// editor webview, the shell runs in this Bun process via the bun:ffi PTY (a port
// of the Swift SessionKit core), and block output streams back over typed RPC.
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

const shell = new PtyProcess({
  executable: "/bin/zsh",
  args: ["-i"],
  env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  cwd: process.env["HOME"],
});
const parser = new MarkerParser(NONCE);

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

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
    },
    messages: {},
  },
});

// Drain the PTY on a short interval, slice it into per-block events, and push
// each event to the webview. (poll()-gated reads never block; see pty.ts.)
setInterval(() => {
  const data = shell.drain();
  if (!data) return;
  for (const ev of parser.feed(data)) {
    if (ev.type === "began") {
      rpc.send.runEvent({ id: ev.blockId, kind: "began" });
    } else if (ev.type === "output") {
      rpc.send.runEvent({ id: ev.blockId, kind: "output", dataB64: toB64(ev.data) });
    } else if (ev.type === "ended") {
      rpc.send.runEvent({ id: ev.blockId, kind: "ended", exitCode: ev.exitCode });
    }
  }
}, 8);

const mainWindow = new BrowserWindow({
  title: "Ledge",
  url: await mainViewUrl(),
  rpc,
  frame: { width: 940, height: 700, x: 200, y: 120 },
});

process.on("exit", () => shell.close());

console.log("[bun] Ledge started, shell pid", shell.pid);
void mainWindow;

