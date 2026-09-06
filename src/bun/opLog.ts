// What a request already did, so a replay does not do it again (remote.md §7).
//
// A connection that drops takes its in-flight requests with it. The client
// cannot tell which of them the server had already run: a `noteWrite` whose
// answer was lost looks the same as one that never arrived. The client
// re-sends them after reconnecting, and this log is what makes that safe.
//
// A replayed `noteWrite` carries a `baseMtimeMs` that its own first
// application already made stale, so it meets the divergence guard writeNote
// keeps for a foreign write (bun/notes.ts). remote.md §7 has the rule for
// every mutating call.
//
// The log belongs to the server, not to a connection: the daemon creates one
// and hands it to every connection it accepts (bun/daemon.ts).

/** The recorded outcome of one op, or the promise that is still producing it. */
type Entry = { at: number; result: Promise<unknown> };

export interface OpLog {
  /**
   * Run `exec` under `key`, or answer from the record when this key has been
   * seen. A key still in flight gets the same promise back, rather than
   * running `exec` a second time. A client that reconnects fast enough
   * replays a request the server is still working on, and running it again
   * would leave two writes racing each other.
   */
  run(key: string, exec: () => Promise<unknown>): Promise<unknown>;
  size(): number;
}

/**
 * Bounded by count and by age, both small.
 *
 * The window only has to cover the requests that were in flight when a link
 * dropped. Those are the only ones a client replays: a handful, not a
 * history. The default `limit` of 64 entries is far more than that. The
 * default `ttlMs` of two minutes outlasts the reconnect ladder, which ends
 * after about half a minute (shared/transport.ts). Every entry keeps the
 * result it recorded, and one of those (terminalAttach's scrollback) runs to
 * a quarter megabyte, so a wider window costs real memory.
 *
 * Failures are recorded too. A replayed `noteWrite` that was refused because
 * the vault is locked is refused again, rather than run a second time for a
 * different answer.
 */
export function createOpLog(opts?: { limit?: number; ttlMs?: number; now?: () => number }): OpLog {
  const limit = opts?.limit ?? 64;
  const ttlMs = opts?.ttlMs ?? 120_000;
  const now = opts?.now ?? (() => Date.now());
  // A Map iterates in insertion order, so the oldest entry is the first one
  // out and eviction needs no second structure to sort.
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
      // Nothing between here and the `seen.set` below may await: a replay
      // arriving in the same tick has to find this promise, not an empty map.
      const result = exec();
      // Mark `result` handled. A rejection with no handler attached counts as
      // unhandled the moment it settles, and Bun ends the process over it. The
      // derived promise is dropped; the record and the caller both get
      // `result` itself.
      void result.catch(() => {});
      seen.set(key, { at: now(), result });
      evict();
      return result;
    },
    size: () => seen.size,
  };
}
