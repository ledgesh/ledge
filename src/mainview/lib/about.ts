// About Ledge's bridge, one of the configureX bridges (architecture.md §5).
// boot.tsx binds `info` to the appInfo RPC, which the client shell answers
// about itself (remote.md §10), and the harness binds a stub. The dialog
// (components/AboutDialog.tsx) calls appInfo without importing either.
import type { AppInfo } from "../../shared/version";
import { versionLine } from "../../shared/version";
import type { ConnectionStatus } from "./connections";

export interface AboutHandlers {
  info(): Promise<AppInfo>;
}

let handlers: AboutHandlers | null = null;

export function configureAbout(h: AboutHandlers): void {
  handlers = h;
}

export function appInfo(): Promise<AppInfo> {
  if (!handlers) throw new Error("about bridge not configured");
  return handlers.info();
}

/**
 * What About Ledge shows and copies: the app's line, then the server this
 * window is connected to and that server's build. The two can differ: a remote
 * server is updated by whoever installed it (remote.md §11), and a daemon from
 * before an update keeps running until it is idle. The server line is left out
 * when the handshake named no build.
 */
export function aboutText(info: AppInfo, connection: Pick<ConnectionStatus, "build">, serverName: string): string {
  const lines = [versionLine(info)];
  if (connection.build) lines.push(`Server: ${serverName}, ledge ${connection.build}`);
  return lines.join("\n");
}
