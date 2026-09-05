// The screen a boot puts up while it is still waiting on a server.
//
// Both shells start on an empty `#root` and fill it once there is something to
// render against (boot.tsx). That gap is a few milliseconds against a server in
// this process and it is seconds against one across a network: a phone dialling
// a machine that is not there waits out the whole dial timeout — fifteen
// seconds (ios/Sources/SSHTransport.swift) — and a Mac that reloaded onto a
// slow link waits out boot's prefetch. Until this, all of that was a black
// rectangle with no words in it and nothing to press, and the refusal at the
// end of the wait was the first thing either shell said. A connection that was
// merely slow and an app that had hung looked identical for as long as it took.
//
// DOM rather than a component, for the reason `ios.tsx` refuse() is: what this
// covers is the stretch before there is a server to render React against, and
// on a phone the boot it covers may never reach React at all. Its button is a
// button and not a command (interactions.md §1) for the same reason — the
// registry is built by CommandProvider, which is downstream of everything this
// is waiting for.
//
// Nothing here is on a timer. The two reveals are CSS animation delays
// (index.css `.ledge-booting`), the same idiom as the inline terminal's
// "waiting" line: a boot that lands inside the delay never paints this at all,
// so the ordinary case costs no flash.

/**
 * What the panel says it is waiting for.
 *
 * The address rather than the connection's name, because that is the string
 * that identifies a machine: two servers can share a name, and a phone's
 * `@hello` carries the destination and not the name anyway (ios.md §4). Empty
 * is the Mac's answer at this point in boot — the connection list is one of the
 * round trips being waited on — and "Connecting…" is the honest thing to say
 * when the machine cannot be named yet.
 */
export function bootingLabel(destination: string): string {
  const where = destination.trim();
  return where ? `Connecting to ${where}…` : "Connecting…";
}

/** The panel, while it is up. Null between boots, which is nearly always. */
let panel: HTMLElement | null = null;

/**
 * Put it up, unless it is already up.
 *
 * First caller wins, and that ordering is deliberate rather than incidental: on
 * a phone `ios.tsx` raises this before the dial, where it knows the destination
 * and has a real way out of it, and `boot.tsx` raises it again a moment later
 * around the prefetch. The second call must not replace a panel that names a
 * machine with one that cannot.
 */
export function showBooting(opts: { destination: string; onCancel?: () => void }): void {
  if (panel) return;
  const root = document.body;
  if (!root) return;

  const box = document.createElement("div");
  box.className = "ledge-booting";
  box.setAttribute("role", "status");
  // Polite, not assertive: this is a progress report, and the reveal delay
  // already means it is only ever announced for a wait somebody noticed.
  box.setAttribute("aria-live", "polite");

  const inner = document.createElement("div");
  inner.className = "ledge-booting-panel";

  const spinner = document.createElement("div");
  spinner.className = "ledge-booting-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const head = document.createElement("p");
  head.className = "ledge-booting-head";
  head.textContent = bootingLabel(opts.destination);

  inner.append(spinner, head);

  // The second reveal, several seconds in. Split from the first because they
  // answer different questions: the first says the app is doing something, and
  // this one says it has been doing it for longer than it should have taken.
  // A connection that lands in between says neither more than once.
  const slow = document.createElement("p");
  slow.className = "ledge-booting-slow";
  slow.textContent = "No answer yet.";
  inner.append(slow);

  // Only where there is somewhere to go. On a phone that is the shell's own
  // server list, which is the screen a failed boot ends on anyway (ios.tsx);
  // on a Mac the wire is already open and the wait is the prefetch behind it,
  // so there is nothing here a button could stop.
  if (opts.onCancel) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ledge-booting-cancel";
    cancel.textContent = "Choose a Different Server";
    cancel.onclick = opts.onCancel;
    inner.append(cancel);
  }

  box.append(inner);
  root.append(box);
  panel = box;
}

/**
 * Take it down.
 *
 * Called by `boot.tsx` immediately before the first render, which is the moment
 * that makes it wrong, and by `ios.tsx` refuse(), which replaces the page with
 * a sentence rather than an app: that path clears `#root`, and this panel is
 * parented to <body> and would otherwise sit over the refusal explaining that
 * we are still connecting.
 */
export function hideBooting(): void {
  panel?.remove();
  panel = null;
}
