// Wraps `v` in single quotes so a POSIX shell interprets nothing inside it.
// A single quote inside `v` is escaped as '\''. Shared by the commands Ledge
// writes for a shell to parse: the ssh preamble (bun/remoteSpawn.ts), the sudo
// script (bun/sudoSpawn.ts) and `ledge run`'s driver (bun/runBlocks.ts).
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
