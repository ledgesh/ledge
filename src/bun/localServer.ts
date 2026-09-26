// This Mac's server: `ledge daemon`, started from this app's own
// bundle and dialled over its socket (remote.md §1).
//
// The app is a client of it the way a phone is: the same socket the ssh pump
// attaches to, the same handshake, the same reconnect ladder. What this module
// adds is the part only the app can do, because only the app knows which
// build it is: notice a daemon another build left behind and make way for a
// fresh one. It imports no Electrobun, so localServer.test.ts drives it with
// the seams below faked.
import { existsSync } from "node:fs";
import { SERVE_ENTRY } from "./cliShim";
import { connectToDaemon, retireDaemon, spawnDaemon, stopDaemon } from "./daemon";
import type { Duplex } from "../shared/transport";

export interface LocalServerOpts {
  /** This app's build, compared with the daemon's hello. */
  build: string;
  /** Electrobun's channel. A "dev" build stops whatever daemon it finds
   * before its first dial, so a relaunch always runs the code just built. */
  channel: string;
  entry?: string;
  execPath?: string;
  /** The process seams, faked by the tests. */
  daemon?: {
    connect(spawn: () => void): Promise<Duplex>;
    spawn(head: readonly string[]): void;
    stop(): Promise<boolean>;
    retire(): boolean;
  };
}

export interface LocalServer {
  /** One dial, for reconnectingClient. Starts a daemon when none answers. */
  dial(): Promise<Duplex>;
  /**
   * Review the daemon that answered, once its hello is in.
   *
   * A daemon of another build is asked to retire once nothing is running
   * (daemon.ts `retireDaemon`): the app that started it was replaced by an
   * update, and the code it runs is the old app's. Its clients are told it is
   * coming back, so this window's ladder dials again and the first dial to
   * find no socket starts a daemon from this bundle. Asked once per daemon:
   * every window reviews the same hello, and a second SIGUSR1 to a daemon
   * already waiting on a run would be noise.
   */
  review(peer: { build: string; instance: string }): "kept" | "retired";
}

export function localServer(opts: LocalServerOpts): LocalServer {
  const entry = opts.entry ?? SERVE_ENTRY;
  const execPath = opts.execPath ?? process.execPath;
  const daemon = opts.daemon ?? {
    connect: (spawn) => connectToDaemon({ spawn }),
    spawn: spawnDaemon,
    stop: () => stopDaemon(),
    retire: () => retireDaemon(),
  };
  let cleared = opts.channel !== "dev";
  let reviewed = "";

  return {
    async dial() {
      if (!cleared) {
        // A dev build's version never changes between builds, so the review
        // below cannot tell a daemon from the last `bun run dev` apart from
        // this one's. Stopping it costs a dev machine nothing it wants kept.
        cleared = true;
        if (!(await daemon.stop())) console.warn("[local] a daemon from an earlier launch is still running");
      }
      return daemon.connect(() => {
        // Checked here rather than left to bun: a missing entry would show up
        // as a daemon that never answered, ten seconds later, with no path in
        // the message.
        if (!existsSync(entry)) throw new Error(`the server entry is missing at ${entry}: rebuild the app`);
        daemon.spawn([execPath, entry]);
      });
    },
    review(peer) {
      if (peer.instance === reviewed) return "kept";
      reviewed = peer.instance;
      if (peer.build === opts.build) return "kept";
      console.warn(`[local] this machine's daemon is build ${peer.build} and this app is ${opts.build}; it restarts when idle`);
      daemon.retire();
      return "retired";
    },
  };
}
