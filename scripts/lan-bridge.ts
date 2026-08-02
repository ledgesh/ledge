// A TCP port in front of this machine's daemon, so an iOS client can reach a
// Ledge server before NIOSSH exists (ios.md §14, phase 3).
//
// It is bun/serve.ts's pump with a socket where stdio was: accept a
// connection, open one to the daemon, move bytes, hang up when either end
// does. It parses no frame, so it cannot desynchronize one, and it adds no
// protocol of its own — the client on the far side is running exactly the
// handshake, ladder and op ids it will run over ssh.
//
// **This is not a shipping mode and it must never become one.** remote.md §3's
// first claim is that the server opens no port, and §4's whole capability
// restriction rests on it: a forced command can only narrow what ssh already
// authenticated, and nothing here authenticates anything at all. Whoever can
// reach this port can read every note on this machine and run commands as this
// user.
//
// So it lives in scripts/, which is in no build — not the app
// (electrobun.config.ts), not the CLI (`build:cli`), not the image
// (Dockerfile) — and "cannot ship" is a fact about the tree rather than a flag
// somebody could flip. src/bun/ports.test.ts holds the other half of the
// claim: nothing under src/ opens a port at all.
//
//   bun run lan            127.0.0.1:8787 — the Simulator shares this Mac's
//                          network stack, so loopback is all it needs
//   bun run lan -- --lan   0.0.0.0:8787 — a real device on the same network
//   bun run lan -- --port 9000
import { connectToDaemon, SOCKET_PATH } from "../src/bun/daemon";
import { APP_HOME } from "../src/bun/workspaces";
import type { Duplex } from "../src/shared/transport";
import { BUILD_VERSION } from "../src/shared/version";

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? "") : null;
};

const port = Number(flag("port") ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[lan] --port ${flag("port")} is not a port`);
  process.exit(2);
}
// Loopback unless asked otherwise, because the reachable case is the dangerous
// one and a default nobody typed should not be it.
const wide = argv.includes("--lan");
const hostname = wide ? "0.0.0.0" : "127.0.0.1";

/**
 * One TCP client, mid-pump.
 *
 * `held` is the bytes that arrived before the daemon connection resolved:
 * connecting is async and the client's hello is already on its way, so
 * without this the handshake would be the thing that gets dropped.
 *
 * `pending` is the other direction. A TCP write can be SHORT — that is the
 * difference between this and the daemon's unix socket, where the kernel
 * buffer has never been the binding constraint — and a frame half-written and
 * half-forgotten is a length prefix that no longer describes what follows.
 */
interface Pump {
  up: Duplex | null;
  held: Uint8Array[];
  pending: Uint8Array[];
  gone: boolean;
}

type Client = Bun.Socket<Pump>;

function send(socket: Client, bytes: Uint8Array): void {
  const { pending } = socket.data;
  if (pending.length > 0) {
    pending.push(bytes);
    return;
  }
  const wrote = socket.write(bytes);
  if (wrote < bytes.length) pending.push(bytes.subarray(Math.max(wrote, 0)));
}

function drain(socket: Client): void {
  const { pending } = socket.data;
  while (pending.length > 0) {
    const head = pending[0]!;
    const wrote = socket.write(head);
    if (wrote < head.length) {
      pending[0] = head.subarray(Math.max(wrote, 0));
      return;
    }
    pending.shift();
  }
}

let served = 0;

const listener = Bun.listen<Pump>({
  hostname,
  port,
  socket: {
    open(socket) {
      const n = (served += 1);
      socket.data = { up: null, held: [], pending: [], gone: false };
      console.log(`[lan] #${n} ${socket.remoteAddress} connected`);
      void connectToDaemon()
        .then((up) => {
          // The client hung up while we were starting a daemon for it.
          if (socket.data.gone) return up.close();
          up.onData = (chunk) => send(socket, chunk);
          up.onClose = () => socket.end();
          socket.data.up = up;
          for (const chunk of socket.data.held.splice(0)) up.write(chunk);
        })
        .catch((err: unknown) => {
          console.error(`[lan] #${n}: no daemon:`, err instanceof Error ? err.message : err);
          socket.end();
        });
    },
    data(socket, chunk) {
      const bytes = new Uint8Array(chunk);
      if (socket.data.up) socket.data.up.write(bytes);
      else socket.data.held.push(bytes);
    },
    drain,
    close(socket) {
      socket.data.gone = true;
      socket.data.up?.close();
      console.log(`[lan] disconnected`);
    },
    error(socket, err) {
      console.error(`[lan] socket error:`, err);
      socket.data.gone = true;
      socket.data.up?.close();
    },
  },
});

console.log(`[lan] ledge ${BUILD_VERSION} on ${hostname}:${listener.port} -> ${SOCKET_PATH}`);
console.log(`[lan] app home: ${APP_HOME}`);
console.log(
  wide
    ? "[lan] REACHABLE FROM THIS NETWORK, AND UNAUTHENTICATED. Anyone who can\n" +
        "[lan] reach this port can read every note here and run commands as you.\n" +
        "[lan] It is a phase-3 fixture (ios.md); stop it when you are done."
    : "[lan] loopback only; pass --lan for a device on this network (and read\n" +
        "[lan] the warning it prints before you do)",
);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    listener.stop(true);
    process.exit(0);
  });
}
