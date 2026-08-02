// The iOS shell's entry point: a socket Swift is holding, and nothing else.
//
// The third of the three (ios.md §1), beside main.tsx's Electrobun RPC and
// harness.tsx's Map. Everything the view does with a server is boot.tsx; what
// is here is how a request becomes bytes on this platform, which is: the
// protocol stack from `shared/transport.ts` running in the webview, fed by
// Swift across the bridge in `lib/nativeBridge.ts`.
//
// So the reconnect ladder, the op ids, the held requests and the instance
// check are the SAME code the Mac runs over ssh. Nothing about being a phone
// re-implements any of it (§2), and the parts that are genuinely a phone's —
// the socket, the pasteboard, the keys — are the ten strings the bridge names.
import { reconnectingClient } from "../shared/transport";
import { BUILD_VERSION } from "../shared/version";
import { bootView, viewPush } from "./boot";
import { attachShell, nativeOverlay } from "./lib/nativeBridge";

// Milestones, in milliseconds since the page began loading.
//
// §5's claim is that foregrounding a phone IS a boot, and that the number to
// measure is the handshake in front of the first round trip — invisible on a
// Mac, whose local server needs none. So the phases are kept apart rather than
// summed: `socket` is the connect, `server` adds the protocol handshake, and
// `view` adds boot.tsx's concurrent prefetch, which remote.md §12 charges as
// one round trip and which this is the way to check.
const marks: string[] = [];
const mark = (what: string): void => void marks.push(`${what}=${Math.round(performance.now())}ms`);

// Two frames: one gets the render scheduled, the second returns after it has
// been composited. An approximation, and the only one a page can make.
const painted = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function start(): Promise<void> {
  const shell = attachShell();
  mark("bridge");
  // Before the first dial: the client id keys the saved layout, and a phone
  // restoring a desktop's three-pane tree onto a 390-point screen is the
  // failure that keying prevents (remote.md §5, ios.md §9).
  const { client, destination } = await shell.hello();
  mark("hello");

  let live = true;
  const wire = await reconnectingClient({
    dial: async () => {
      const socket = await shell.dial();
      mark("socket");
      return socket;
    },
    push: viewPush,
    build: BUILD_VERSION,
    client,
    onState: (state, detail) => {
      live = state === "live";
      shell.log(`[link] ${state}: ${detail}`);
      viewPush.connectionState({ state, detail });
    },
  });
  const peer = await wire.ready;
  mark("server");

  // §5, made literal: foregrounding is a boot. The shell closes the socket on
  // the way out (a suspended app's socket dies anyway, and a half-open one
  // looks live until the first write fails), so the wire is never live on the
  // way back in and this reloads. The condition is not dead code — it is what
  // makes an app switch that never suspended cost nothing — and the number
  // that decides whether holding the socket across a short trip is worth
  // building is the boot latency the line below reports.
  shell.onResume(() => {
    if (!live) window.location.reload();
  });

  // Choosing the server again, from the connection chrome, is the same boot:
  // the ladder gives up for good when a restarted server answers with a new
  // instance, and nothing below the transport can rebuild a session's state
  // (shared/transport.ts). Reloading is how a page starts over.
  await bootView(nativeOverlay(wire.requests, shell, peer.build, () => window.location.reload()));
  mark("view");
  await painted();
  mark("paint");
  shell.log(`[boot] ${destination}, ledge-server ${peer.build}: ${marks.join(" ")}`);
}

/**
 * Say so, plainly.
 *
 * A phone that cannot reach a server has no notes to show (ios.md §1), and
 * that is the product rather than a degradation of it — but only if it says
 * which machine it could not reach and why. Written as DOM rather than as a
 * component because the thing that failed may be the reason React never got a
 * server to render against.
 */
function refuse(err: unknown): void {
  const why = err instanceof Error ? err.message : String(err);
  console.error("[ios] could not start", err);
  const root = document.getElementById("root");
  if (!root) return;
  root.textContent = "";
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText =
    "font:15px/1.5 -apple-system,system-ui,sans-serif;padding:2rem;max-width:32rem;margin:0 auto;color:inherit";
  const head = document.createElement("p");
  head.style.cssText = "font-weight:600;margin:0 0 .5rem";
  head.textContent = "Ledge could not reach a server.";
  const detail = document.createElement("p");
  detail.style.cssText = "margin:0 0 1.25rem;opacity:.7";
  detail.textContent = why;
  const again = document.createElement("button");
  again.style.cssText =
    "font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid currentColor;background:none;color:inherit";
  again.textContent = "Try again";
  again.onclick = () => window.location.reload();
  box.append(head, detail, again);
  root.append(box);
}

void start().catch(refuse);
