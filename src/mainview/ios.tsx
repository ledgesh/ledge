// The iOS entry point: the view over a socket Swift holds. ios.tsx is the
// third entry point, beside main.tsx and harness.tsx (ios.md §1), and boot.tsx
// holds everything the view does with a server. Here a request becomes bytes:
// `shared/transport.ts` runs in the webview, and Swift carries its frames
// across `lib/nativeBridge.ts`. So the reconnect ladder, the op ids, the held
// requests and the instance check are the same code the Mac runs over ssh
// (ios.md §2). Only the socket, the pasteboard and the keys are a phone's own:
// the nineteen calls in `SHELL_CALLS`.
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
// Foregrounding a phone is a boot (ios.md §5), so the number to measure is the
// handshake in front of the first round trip. A Mac's local server needs none
// of it. The phases stay apart rather than summed: `socket` is the connect,
// `server` adds the protocol handshake, and `view` adds boot.tsx's concurrent
// prefetch, which remote.md §12 charges as one round trip. Timing `view` on
// its own is how that charge gets checked.
const marks: string[] = [];
const mark = (what: string): void => void marks.push(`${what}=${Math.round(performance.now())}ms`);

// Two frames: the first gets the render scheduled, the second returns after it
// has been composited. An approximation, because a page cannot observe the
// composite itself.
const painted = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * The shell, kept where `refuse` below can reach it.
 *
 * A failed boot ends on a page with no React in it, so the way off it is a
 * native call: the connection dialog that would point this somewhere else is a
 * component, and there is no component tree. Null only when the boot failed
 * before `attachShell` returned, and then the refusal has no button to offer.
 */
let bridge: Shell | null = null;

async function start(): Promise<void> {
  const shell = (bridge = attachShell());
  mark("bridge");
  // Asked before the first dial, because the client id keys the saved layout
  // (remote.md §5). Keying it stops a phone restoring a desktop's three-pane
  // tree onto a 390-point screen (ios.md §9).
  const { client, label, destination, key } = await shell.hello();
  mark("hello");

  // A phone runs a note's blocks and has no terminal drawer (ios.md §8 gives
  // the reasoning for both, and for splitting them into two booleans). Set
  // before anything renders (bootView below is the first render), because these
  // booleans decide which verbs exist: a terminal button that appears for one
  // frame and then leaves is worse than either answer.
  configureShell({
    runsBlocks: true,
    // False for good rather than until a later phase: a drawer is a second
    // arrangement, a second focus domain, and a keyboard grammar (Ctrl-`,
    // Escape) a phone has no way to type.
    hasTerminal: false,
    // Which key authenticates, and not a cut. This client has one key of its
    // own, in the Secure Enclave, so the connection form shows the line to
    // install rather than asking for a path to a file that does not exist
    // (ios.md §4).
    deviceKey: key,
    // How that line leaves the phone. The connection form offers the sheet
    // beside Copy Line, because a copy on a phone can only be pasted on the
    // phone, and the server is somewhere else (ios.md §4).
    shareSheet: (text) => void shell.call("share.text", { text }).catch(() => {}),
    // A fact about this shell rather than a cut. Focus here raises a keyboard
    // over a page that drops every edit, so the read-only documentation editor
    // is not editable on a phone (lib/shell.ts).
    softKeyboard: true,
    multiWindow: false,
  });

  // Everything from here to the first paint waits on another machine, and a
  // phone dialling one that is not there waits out the whole dial timeout:
  // fifteen seconds (`SSHTransport.dialTimeout`). That wait used to be a black
  // screen, with refuse() below as the first thing the app said. This says it
  // sooner, and names the machine (lib/booting.ts).
  //
  // Raised here rather than inside bootView, which raises it again over the
  // prefetch. Only this end knows the destination, from the hello above, and
  // where to send a person who has waited long enough.
  showBooting({
    destination,
    // That is the shell's own server list, the screen a failed boot ends on
    // anyway. Not a retry: a dial this slow means the server has moved or gone
    // away, and dialling it again has been tried.
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
    // So another client's presence names this phone rather than "another
    // device" (wire.ts `Hello.label`, remote.md §7). Asked of Swift once, with
    // the id, because the device name is UIKit's answer and not the page's.
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
  // The hold this client actually got. Computed here rather than read off a
  // reply, because the two hellos cross rather than answering each other
  // (wire.ts `Hello.hold`). Only reported: nothing in the view behaves
  // differently for it yet. The log line below is where a live probe sees that
  // a server clamped the hold this client asked for.
  const held = sessionHold(SESSION_HOLD_MS, peer.hold);

  // Foregrounding is a boot (ios.md §5). The shell closes the socket on the way
  // out, because a suspended app's socket dies anyway and a half-open one looks
  // live until the first write fails. So the wire is not live on the way back
  // in and the page reloads. The `live` check is not dead code: an app switch
  // that never suspended costs nothing. The boot latency in the log line below
  // is the number that would say whether holding the socket across a short trip
  // is worth building.
  shell.onResume(() => {
    if (!live) window.location.reload();
  });

  // The accessory bar above the keyboard (ios.md §7). Swift holds the buttons
  // and their command ids. What an id means is the command registry's answer,
  // through the seam the Mac's menu bar uses too (lib/menu.ts). Registered
  // before bootView so a tap during the first paint has somewhere to go. It
  // lands on a no-op until CommandProvider mounts.
  shell.onVerb((id) => dispatchNativeCommand(id));
  // The same seam for the bar's other face: a key pressed at a running block,
  // addressed to whichever panel has the keyboard (editor/inlineTerm.ts). Not
  // the command registry, because these are not verbs. A palette entry for
  // Ctrl-C would act on a focus that opening the palette has already taken
  // away.
  shell.onKey((name) => void sendRunKey(name));
  watchEditorFocus(shell);

  // Choosing a server from the connection chrome, the same one or another, runs
  // this boot again. Everything workspace-scoped is scoped to a server
  // (remote.md §8), and this boot is what builds all of it. Reloading is how the
  // page starts over, and `lib/connections.ts` reloads once, after flushing.
  await bootView(nativeOverlay(wire, shell, peer.build));
  mark("view");
  await painted();
  mark("paint");
  shell.log(`[boot] ${destination}, ledge-server ${peer.build}, hold ${Math.round(held / 1000)}s: ${marks.join(" ")}`);
}

/**
 * Tell the shell which surface the keyboard is over, so its accessory bar
 * wears the right face (ios.md §7).
 *
 * Here rather than in the view, because it is a fact about this shell and no
 * other: on a Mac nothing hangs off which element has focus, and the view has
 * no business knowing that a phone's accessory bar exists. `barFaceOf` maps an
 * element to a face. It lives in lib/nativeBridge.ts beside `focusReporter`,
 * the filter that consumes its answer.
 */
function watchEditorFocus(shell: Pick<Shell, "focus">): void {
  const report = focusReporter((over) => shell.focus(over));
  // A timeout rather than a microtask. Microtasks drain between event
  // listeners, so a check queued from `focusout` would still run while
  // `activeElement` is the body, and would report a blur that the `focusin` a
  // moment later contradicts. A timeout runs after the whole move has settled,
  // so the pair collapses to one report.
  const later = (): void => void setTimeout(() => report(barFaceOf(document.activeElement)), 0);
  document.addEventListener("focusin", later, true);
  document.addEventListener("focusout", later, true);
}

/**
 * The page a failed boot ends on: what could not be reached, and why.
 *
 * A phone that cannot reach a server has no notes to show (ios.md §1), so the
 * refusal has to name the machine and the error. Written as DOM rather than as
 * a component, because what failed may be the reason React never got a server
 * to render against.
 */
function refuse(err: unknown): void {
  // Taking the boot screen down comes first. It is parented to <body> rather
  // than to the #root cleared below (lib/booting.ts), so left up it would cover
  // the refusal with a panel that still says the app is connecting.
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
  // The way out when the server moved. The server list belongs to the
  // connection dialog, the dialog is React, and a failed boot never reached
  // React. Without this button, Try again would be the only control here, and
  // it would keep failing the same way. `servers.choose` hands the window back
  // to the shell, which has its own list and can add to it (ios.md §4).
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

/** One button on the refusal page. Its styles are inline, like the rest of that
 * page, because there is no stylesheet here to name a class from. */
function button(label: string, onclick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.style.cssText =
    "font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid currentColor;background:none;color:inherit";
  el.textContent = label;
  el.onclick = onclick;
  return el;
}

void start().catch(refuse);
