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
// the socket, the pasteboard, the keys — are the eighteen strings the bridge
// names.
import { reconnectingClient, SESSION_HOLD_MS } from "../shared/transport";
import { sessionHold } from "../shared/wire";
import { BUILD_VERSION } from "../shared/version";
import { bootView, viewPush } from "./boot";
import { hideBooting, showBooting } from "./lib/booting";
import { attachShell, barFaceOf, focusReporter, nativeOverlay, type Shell } from "./lib/nativeBridge";
import { sendRunKey } from "./editor/inlineTerm";
import { dispatchNativeCommand } from "./lib/menu";
import { configureShell } from "./lib/shell";

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

/**
 * The bridge, where `refuse` below can reach it.
 *
 * A boot that fails ends on a page with no React in it, and the way off that
 * page is a native call: the connection dialog that would otherwise answer
 * "point this somewhere else" is a component, and there is no component tree.
 * Null only when there was no shell to attach at all, which is the one refusal
 * with nothing to offer.
 */
let bridge: Shell | null = null;

async function start(): Promise<void> {
  const shell = (bridge = attachShell());
  mark("bridge");
  // Before the first dial: the client id keys the saved layout, and a phone
  // restoring a desktop's three-pane tree onto a 390-point screen is the
  // failure that keying prevents (remote.md §5, ios.md §9).
  const { client, label, destination, key } = await shell.hello();
  mark("hello");

  // A phone runs a note's blocks, and has no terminal drawer (ios.md §8). Set
  // before anything renders — bootView below is the first of that — because
  // what this decides is which verbs EXIST: a terminal button that appears for
  // one frame and then leaves is worse than either answer.
  //
  // v1 said false to both, for the interaction surface rather than because it
  // could not work: the daemon on the other end spawns PTYs perfectly well.
  // Lifting the first is what the two booleans were split for. A run is a panel
  // under the fence, the ▶ on that fence is lit and 44 points because a finger
  // has no hover to summon it with, the run takes the keyboard when it first
  // speaks and hands it back on Back to note (interactions.md §1a, §6a), and it
  // outlives the connection that carried it (remote.md §7).
  //
  // `hasTerminal` stays false, and is where a phone stays rather than a step
  // not yet taken: a drawer is a second arrangement, a second focus domain, and
  // a keyboard grammar (Ctrl-`, Escape) a phone has no way to type.
  //
  // The other two are facts about this shell rather than cuts. This client
  // authenticates with one key of its own, in the Secure Enclave, so the
  // connection form shows the line to install rather than asking for a path to
  // a file that does not exist (§4); and its keyboard is on screen, which is
  // what makes focus expensive enough for the read-only editor to give it up
  // (lib/shell.ts).
  configureShell({
    runsBlocks: true,
    hasTerminal: false,
    deviceKey: key,
    // And the way that line leaves the phone. The connection form offers it
    // beside Copy Line, because a copy on a phone can only be pasted on the
    // phone and the server is not there (ios.md §4).
    shareSheet: (text) => void shell.call("share.text", { text }).catch(() => {}),
    softKeyboard: true,
    multiWindow: false,
  });

  // Everything from here to the first paint is a wait on a machine that is not
  // this one, and a phone dialling one that is not there waits out the whole
  // dial timeout — fifteen seconds (SSHTransport.dialTimeout). That was a black
  // screen with nothing in it, and refuse() below was the first thing the app
  // said. This says it sooner, and says which machine (lib/booting.ts).
  //
  // Raised here rather than inside bootView, which raises it again over the
  // prefetch, because this end knows the two things that one cannot: the
  // destination, from the hello above, and where a person who has waited long
  // enough should be sent. That is the shell's own server list — the screen a
  // failed boot ends on anyway — and not a retry: a dial this slow is a server
  // that has moved or gone away, and dialling it again is the answer that has
  // already been tried.
  showBooting({
    destination,
    onCancel: () => {
      void shell.call("servers.choose", { because: `Gave up connecting to ${destination}.` }).catch(() => {});
    },
  });

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
    // So the Mac that loses a drawer to this phone can say which phone
    // (remote.md §7). Asked of Swift once, with the id, because the device name
    // is UIKit's answer and not the page's.
    label,
    hold: SESSION_HOLD_MS,
    onState: (state, detail) => {
      live = state === "live";
      shell.log(`[link] ${state}: ${detail}`);
      viewPush.connectionState({ state, detail });
    },
  });
  const peer = await wire.ready;
  mark("server");
  // What the ask above actually bought. Computed here rather than read off a
  // reply, because the two hellos cross rather than answering each other
  // (wire.ts `Hello.hold`). Reported and not acted on: nothing in the view
  // behaves differently for it yet, and a server whose ceiling is under this
  // client's ask is precisely what a live probe has to be able to see.
  const held = sessionHold(SESSION_HOLD_MS, peer.hold);

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

  // The accessory bar above the keyboard (ios.md §7). Swift holds the buttons
  // and their command ids; what a command id means is the registry's, here, as
  // it is for the Mac's menu bar — which is why this is the same seam and not
  // a second one (lib/menu.ts). Registered before bootView so a tap during the
  // first paint has somewhere to go; it lands on a no-op until CommandProvider
  // mounts, which is the right answer to a button pressed before there is an
  // editor to press it against.
  shell.onVerb((id) => dispatchNativeCommand(id));
  // The same seam for the bar's other face, one domain along: a key pressed at
  // a running block, addressed to whichever panel has the keyboard
  // (editor/inlineTerm.ts). Not the registry, because these are not verbs — a
  // palette entry for Ctrl-C would be a command that acts on a focus the act of
  // opening the palette has already taken away.
  shell.onKey((name) => void sendRunKey(name));
  watchEditorFocus(shell);

  // Choosing a server from the connection chrome — the same one, or another —
  // is the same boot: the ladder gives up for good when a restarted server
  // answers with a new instance, and nothing below the transport can rebuild a
  // session's state (shared/transport.ts). Reloading is how a page starts over,
  // and `lib/connections.ts` does it once, after flushing.
  await bootView(nativeOverlay(wire, shell, peer.build));
  mark("view");
  await painted();
  mark("paint");
  shell.log(`[boot] ${destination}, ledge-server ${peer.build}, hold ${Math.round(held / 1000)}s: ${marks.join(" ")}`);
}

/**
 * Tell the shell which keyboard the keyboard is over (ios.md §7).
 *
 * Here rather than in the view, because it is a fact about this shell and no
 * other: on a Mac nothing hangs off which element has focus, and the view has
 * no business knowing that a phone's accessory bar exists. Which surface an
 * element belongs to is `barFaceOf`, beside the filter it feeds.
 *
 * Deferred to a timeout, and a microtask is not enough: microtasks drain
 * between event listeners, so a check queued from `focusout` would still run
 * while `activeElement` is the body and report a blur that the `focusin` a
 * moment later contradicts. A timeout runs after the whole move has settled,
 * and the pair of them collapses to one report.
 */
function watchEditorFocus(shell: Pick<Shell, "focus">): void {
  const report = focusReporter((over) => shell.focus(over));
  const later = (): void => void setTimeout(() => report(barFaceOf(document.activeElement)), 0);
  document.addEventListener("focusin", later, true);
  document.addEventListener("focusout", later, true);
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
  // First: this page is what the boot screen was waiting to become, and that
  // screen is parented to <body> rather than to the #root cleared below — left
  // up, it would cover the refusal with a claim that we are still connecting.
  hideBooting();
  const why = err instanceof Error ? err.message : String(err);
  console.error("[ios] could not start", err);
  bridge?.log(`[boot] refused: ${why}`);
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
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:.5rem;flex-wrap:wrap";
  // Retrying first, because the ordinary reason a phone cannot reach its server
  // is that the phone moved and not that the server did.
  buttons.append(button("Try again", () => window.location.reload()));
  // And the way out when it did. Without this the only control on this page is
  // one that will fail the same way for as long as anyone presses it: the list
  // of servers is the connection dialog's, the dialog is React, and React is
  // what a failed boot never got to. `servers.choose` hands the window back to
  // the shell, which has its own list and can add to it (ios.md §4).
  if (bridge) {
    const shell = bridge;
    buttons.append(
      button("Choose a server", () => {
        // The refusal goes with it, so the list says why it is being shown.
        void shell.call("servers.choose", { because: why }).catch(() => {});
      }),
    );
  }
  box.append(head, detail, buttons);
  root.append(box);
}

/** One button on the refusal page, styled the way the page around it is: as
 * inline text, because there is no stylesheet here to name a class from. */
function button(label: string, onclick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.style.cssText =
    "font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid currentColor;background:none;color:inherit";
  el.textContent = label;
  el.onclick = onclick;
  return el;
}

void start().catch(refuse);
