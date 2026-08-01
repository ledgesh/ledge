// What a request already did, so a replay does not do it again (remote.md §7).
//
// A connection that drops takes its in-flight requests with it, and the client
// cannot tell which of them the server had already run: a `noteWrite` whose
// answer was lost is indistinguishable from one that never arrived. So the
// client re-sends them after reconnecting, and this is what makes that safe.
//
// The failure it exists to prevent is specific and nasty. A save applied twice
// finds its own bytes on disk the second time, fails the `baseMtimeMs`
// divergence guard, and trash-copies the user's own work as somebody else's
// change. With this, the divergence guard goes back to meaning what it has
// always meant: somebody else wrote the file.
//
// It belongs to the SERVER, not to a connection — a window that only spans one
// connection would be forgotten at the exact moment it is needed. The daemon
// creates one and hands it to every connection it accepts.

/** The recorded outcome of one op, or the promise that is still producing it. */
type Entry = { at: number; result: Promise<unknown> };

export interface OpLog {
  /**
   * Run `exec` under `key`, or answer from the record if this key has been
   * seen. A key still in flight gets the SAME promise rather than a second
   * run: a client that reconnects fast enough can replay a request the server
   * is still working on, and two writes racing each other is the very thing
   * this prevents.
   */
  run(key: string, exec: () => Promise<unknown>): Promise<unknown>;
  size(): number;
}

/**
 * Bounded by count and by age, both small.
 *
 * The window only has to cover requests that were IN FLIGHT when a link
 * dropped, because those are the only ones a client replays — a handful, not a
 * history. 64 entries is far more than that, and two minutes is longer than
 * the reconnect ladder runs before it gives up. Sizing it generously would
 * mean holding recorded RESULTS, and one of them (terminalAttach's scrollback
 * replay) is a quarter megabyte.
 *
 * Failures are recorded too. A refusal is an answer: replaying a `noteWrite`
 * that was refused for a locked vault must be refused again, not retried into
 * a different one.
 */
export function createOpLog(opts?: { limit?: number; ttlMs?: number; now?: () => number }): OpLog {
  const limit = opts?.limit ?? 64;
  const ttlMs = opts?.ttlMs ?? 120_000;
  const now = opts?.now ?? (() => Date.now());
  // Insertion-ordered, which is what makes the oldest entry the first one out
  // without a second structure to sort.
  const seen = new Map<string, Entry>();

  function evict(): void {
    const cutoff = now() - ttlMs;
    for (const [k, e] of seen) {
      if (e.at >= cutoff) break; // insertion order is age order
      seen.delete(k);
    }
    while (seen.size > limit) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  return {
    run(key, exec) {
      const hit = seen.get(key);
      if (hit) return hit.result;
      // Stored BEFORE the first await, so a replay that arrives in the same
      // tick finds the promise rather than an empty map.
      const result = exec();
      // Nothing else awaits this copy, and an op that failed is answered from
      // the record; without the catch its rejection is unhandled the moment it
      // settles and Bun takes the process down for it.
      void result.catch(() => {});
      seen.set(key, { at: now(), result });
      evict();
      return result;
    },
    size: () => seen.size,
  };
}
