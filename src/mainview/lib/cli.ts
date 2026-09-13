// The Install Shell Command bridge, one of the configureX bridges
// (architecture.md §5). boot.tsx binds `install` to the cliInstall RPC, which
// the client shell answers for itself (remote.md §10), and the harness binds
// a stub. The command registry calls installCli without importing either. The
// shell composes the finished message: only it knows where the shims landed
// and what it did about PATH. The view only picks the strip, neutral on
// success and error on failure.
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
