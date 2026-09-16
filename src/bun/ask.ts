// One question at a time on stderr, answered on stdin (interactions.md §9:
// stdout is for results, stderr for talk). `ledge backup setup` and `ledge
// pair` share it.
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let pending = "";

/** One line from stdin. Bytes past the newline are kept for the next question. */
async function readLine(): Promise<string> {
  reader ??= Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const nl = pending.indexOf("\n");
    if (nl >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      return line.replace(/\r$/, "");
    }
    const { value, done } = await reader.read();
    if (done) {
      const line = pending;
      pending = "";
      return line;
    }
    pending += decoder.decode(value, { stream: true });
  }
}

/** One line typed without echo: raw mode, one keystroke per read. */
async function readHidden(): Promise<string> {
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (on: boolean) => void };
  stdin.setRawMode?.(true);
  reader ??= Bun.stdin.stream().getReader();
  let line = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return line;
      for (const byte of value) {
        if (byte === 0x03) process.exit(130);
        if (byte === 0x0d || byte === 0x0a) return line;
        if (byte === 0x7f || byte === 0x08) line = line.slice(0, -1);
        else if (byte >= 0x20) line += String.fromCharCode(byte);
      }
    }
  } finally {
    stdin.setRawMode?.(false);
  }
}

export async function ask(question: string, o: { hidden?: boolean } = {}): Promise<string> {
  process.stderr.write(`${question}: `);
  if (o.hidden && process.stdin.isTTY) {
    const line = await readHidden();
    process.stderr.write("\n");
    return line.trim();
  }
  return (await readLine()).trim();
}
