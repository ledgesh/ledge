// The Install Shell Command bridge, one of the configureX bridges
// (architecture.md §5). boot.tsx binds `install` to the cliInstall RPC and the
// harness binds a stub. The command registry calls installCli without
// importing either. Bun composes the finished message: only it knows where the
// shim landed and whether that folder is on PATH. The view only picks the
// strip, neutral on success and error on failure.
export interface CliHandlers {
  install(): Promise<{ ok: boolean; message: string }>;
}

let handlers: CliHandlers | null = null;

export function configureCli(h: CliHandlers): void {
  handlers = h;
}

export function installCli(): Promise<{ ok: boolean; message: string }> {
  if (!handlers) throw new Error("cli bridge not configured");
  return handlers.install();
}
