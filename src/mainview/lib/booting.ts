// The screen a boot puts up while it waits on a server (interactions.md §4-1).
// Both shells start on an empty `#root` and fill it once there is something to
// render against (boot.tsx). Locally that gap is milliseconds. Across a
// network it is seconds. A phone dialling a machine that is not there waits
// out the fifteen-second dial timeout (ios/Sources/SSHTransport.swift), and a
// Mac reloading onto a slow link waits out boot's prefetch. Without this panel
// the wait is a blank window, and a slow connection looks like a hung app
// until the refusal arrives.
//
// The panel is DOM rather than a React component, for the same reason as
// `ios.tsx` refuse(). It covers the stretch before there is a server to render
// React against. On a phone that boot may never reach React at all. Its button
// is a button and not a command (interactions.md §1) because CommandProvider
// builds the command registry, downstream of everything this waits for.
//
// Nothing here is on a timer. Both reveals are CSS animation delays (index.css
// `.ledge-booting`), the same idiom as the inline terminal's waiting line. A
// boot that lands inside the first delay never paints this at all.

/**
 * What the panel says it is waiting for.
 *
 * The label names the address rather than the connection's name, because two
 * servers can share a name. A phone's `@hello` answers with a destination and
 * no server name anyway (ios.md §5). On a Mac the destination is empty this
 * early in boot: the connection list is one of the round trips being waited
 * on. The label then reads "Connecting…" and names no machine.
 */
export function bootingLabel(destination: string): string {
  const where = destination.trim();
  return where ? `Connecting to ${where}…` : "Connecting…";
}

/** The panel while it is up. Null between boots. */
let panel: HTMLElement | null = null;

/**
 * Puts the panel up, unless it is already up.
 *
 * The first caller wins. On a phone `ios.tsx` raises this before the dial,
 * where it knows the destination and has a way out of it, and `boot.tsx`
 * raises it again a moment later around the prefetch. The second call must not
 * replace a panel that names a machine with one that cannot.
 */
export function showBooting(opts: { destination: string; onCancel?: () => void }): void {
  if (panel) return;
  const root = document.body;
  if (!root) return;

  const box = document.createElement("div");
  box.className = "ledge-booting";
  box.setAttribute("role", "status");
  // Polite rather than assertive: the panel reports progress, and has nothing
  // that has to interrupt what a screen reader is already saying.
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

  // The second reveal, four seconds in (index.css `.ledge-booting-slow`). The
  // first line says the app is doing something. This one says it has been
  // doing it for longer than it should have taken. A boot that lands between
  // the two reveals shows the first line and never this one.
  const slow = document.createElement("p");
  slow.className = "ledge-booting-slow";
  slow.textContent = "No answer yet.";
  inner.append(slow);

  // The button is drawn only where there is somewhere to go. On a phone that
  // is the shell's own server list, the screen a failed boot ends on anyway
  // (ios.tsx). On a Mac the wire is already open and the wait is the prefetch
  // behind it, so there is nothing a button could stop.
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
 * Takes the panel down.
 *
 * `boot.tsx` calls this immediately before the first render, the moment the
 * panel goes stale. `ios.tsx` refuse() calls it too. That path clears `#root`
 * and replaces the page with a sentence, and this panel is parented to
 * <body>. Left up, it would cover the refusal with a panel reading
 * "Connecting to …".
 */
export function hideBooting(): void {
  panel?.remove();
  panel = null;
}
