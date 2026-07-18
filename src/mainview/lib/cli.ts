// The Install Shell Command bridge — the configureX pattern (architecture.md
// §5): main.tsx binds `install` to the cliInstall RPC, the harness binds a
// stub, and the command registry reaches it through installCli without
// importing either. The result is already a finished message: Bun composes
// it (it alone knows where the shim landed and what PATH says), the view
// only chooses which strip shows it.
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
