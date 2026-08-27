import { test, expect, describe } from "bun:test";
import { MarkerParser, markerCommand, markerInit } from "./markers";
import { SUPPORTED_SHELLS } from "./spawnParams";

const NONCE = "testnonce";
const enc = new TextEncoder();
const dec = new TextDecoder();

// Raw OSC 133 markers as the shell would emit them: C from the block's own line,
// D from the precmd hook (see markerCommand / markerInit).
const begin = (id: string, nonce = NONCE) => enc.encode(`\x1b]133;C;ledge=${nonce}:${id}\x07`);
const end = (id: string, code = 0, nonce = NONCE) => enc.encode(`\x1b]133;D;${code};ledge=${nonce}:${id}\x07`);
const bytes = (s: string) => enc.encode(s);

// Concatenate byte chunks, mirroring a single PTY read.
function join(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// The text of every "output" event, concatenated.
function outputText(events: ReturnType<MarkerParser["feed"]>): string {
  return events
    .filter((e) => e.type === "output")
    .map((e) => dec.decode((e as { data: Uint8Array }).data))
    .join("");
}

describe("markerCommand / markerInit", () => {
  test("the block's line does not carry the end marker", () => {
    const cmd = markerCommand("source /tmp/b.sh", NONCE, "web-1");
    // The whole point: an interrupt aborts this line, so anything on it that was
    // meant to report the exit code would never run. Only the start marker lives
    // here; the end comes from the prompt hook.
    expect(cmd).toContain("133;C;");
    expect(cmd).not.toContain("133;D;");
  });

  test("the block's line names the block for the hook to report", () => {
    expect(markerCommand("source /tmp/b.sh", NONCE, "web-7")).toContain("__ledge_id=web-7");
  });

  test("the hook reports the end, tagged and with the real status", () => {
    const init = markerInit(NONCE);
    expect(init).toContain("precmd_functions+=(__ledge_precmd)");
    expect(init).toContain("133;D;");
    expect(init).toContain(`ledge=${NONCE}`);
    // $? has to be captured before anything else in the function can clobber it.
    expect(init).toMatch(/__ledge_precmd\(\) \{ local rc=\$\?;/);
  });

  test("the first byte written to a fresh pty is expendable", () => {
    // This line is the first thing ever written to a new pty, and on Linux the
    // first byte of it can be swallowed by a line discipline that is still
    // coming up. There is no error to see when it happens: one byte short, the
    // definition names `_ledge_precmd` and the registration still names
    // `__ledge_precmd`, so every block begins and none ever ends. A leading
    // newline is what makes the loss cost nothing — whatever is left of it is
    // an empty command line, and the definition starts on the next one.
    const init = markerInit(NONCE);
    expect(init.startsWith("\n")).toBe(true);
    expect(init.slice(1).startsWith("__ledge_precmd()")).toBe(true);
    // And the sacrifice has to be a byte the shell does nothing with: losing
    // part of a padding COMMAND would leave the rest of it to run.
    expect(init.indexOf("\n")).toBe(0);
  });

  // What makes a lost hook detectable instead of permanent. The C marker rides
  // on the block's own line and arrives whatever happened to the hook, so
  // without an ack a shell that never installed one is indistinguishable from a
  // working shell right up until the block fails to end — and by then there is
  // nothing to be done about it.
  test("the hook says so once it is installed", () => {
    const init = markerInit(NONCE);
    expect(init).toContain(`133;R;ledge=${NONCE}`);
  });

  test("the ack is the last thing on the line, so no damage can outlive it", () => {
    // Anything that truncates this line takes the ack with it. Put earlier, a
    // line cut after the ack and before the registration would report a hook
    // that is not there, which is worse than no ack at all.
    const init = markerInit(NONCE);
    expect(init.trimEnd().endsWith(`printf '\\033]133;R;ledge=${NONCE}\\a'`)).toBe(true);
    expect(init.indexOf("133;R;")).toBeGreaterThan(init.indexOf("precmd_functions"));
    expect(init.indexOf("133;R;")).toBeGreaterThan(init.indexOf("PROMPT_COMMAND="));
  });

  test("the hook stays quiet when no block is running", () => {
    // Prompts happen for reasons other than blocks; without this guard every one
    // of them would emit an end marker for whatever ran last.
    expect(markerInit(NONCE)).toContain('[ -n "$__ledge_id" ] || return');
  });

  test("a block's id is cleared once reported, so it is reported once", () => {
    expect(markerInit(NONCE)).toContain("__ledge_id=; }");
  });

  test("the hook registers in zsh and bash alike", () => {
    // Remote inline shells are bash (bun/remoteSpawn.ts); local ones zsh. The
    // one init line must land the hook in whichever it hits, and its body must
    // stay POSIX — a zsh-ism would error line-by-line in bash and never report
    // an end marker, leaving every remote block Running forever.
    const init = markerInit(NONCE);
    expect(init).toContain("precmd_functions+=(__ledge_precmd)");
    expect(init).toContain('PROMPT_COMMAND="__ledge_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"');
    expect(init).not.toContain("[[");
  });

  test("zsh's partial-line mark is off, and only inside the zsh branch", () => {
    // PROMPT_SP prints a reverse-video `%` (plus padding and a CR) before every
    // prompt. It is emitted before precmd, so it lands INSIDE the C..D window the
    // parser keeps, and its self-erase is sized to the pty's winsize — mismatch
    // the panel's grid and the `%` survives as a stray line under the output.
    // Nobody reads this shell's prompt, so the option only ever costs.
    const init = markerInit(NONCE);
    expect(init).toContain("unsetopt PROMPT_SP");
    // `unsetopt` is a zsh builtin: reaching a remote bash it would be a
    // command-not-found on the init line, which is the line that also installs
    // the end-marker hook.
    const zshBranch = init.slice(init.indexOf('if [ -n "$ZSH_VERSION" ]'), init.indexOf("else "));
    expect(zshBranch).toContain("unsetopt PROMPT_SP");
  });

  // The invariant behind SUPPORTED_SHELLS (bun/spawnParams.ts): the set of
  // shells Ledge will resolve to is exactly the set this init has a hook for.
  // A shell added to that list without a branch here spawns happily and never
  // ends a block — no output, no exit code — which is the failure the list
  // exists to prevent, so the pairing is pinned rather than remembered.
  test("the supported shells are exactly the ones this init installs a hook for", () => {
    const init = markerInit(NONCE);
    expect([...SUPPORTED_SHELLS]).toEqual(["zsh", "bash"]);
    // zsh by its own hook array...
    expect(init).toContain("precmd_functions+=(__ledge_precmd)");
    // ...and bash by the variable only it runs before each prompt. dash and
    // fish have neither, which is why neither is on the list.
    expect(init).toContain("PROMPT_COMMAND=");
  });
});

describe("MarkerParser", () => {
  test("slices a full begin/output/end stream", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(join(begin("1"), bytes("hello world"), end("1", 0)));
    expect(events.map((e) => e.type)).toEqual(["began", "output", "ended"]);
    expect(outputText(events)).toBe("hello world");
    expect(events[0]).toMatchObject({ type: "began", blockId: "1" });
    expect(events[2]).toMatchObject({ type: "ended", blockId: "1", exitCode: 0 });
  });

  test("propagates a non-zero exit code", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(join(begin("1"), bytes("boom"), end("1", 3)));
    expect(events[events.length - 1]).toMatchObject({ type: "ended", blockId: "1", exitCode: 3 });
  });

  test("drops output emitted outside any block (prompt / echo noise)", () => {
    const p = new MarkerParser(NONCE);
    expect(p.feed(bytes("user@host % "))).toEqual([]);
  });

  test("accepts the ST (ESC-backslash) terminator as well as BEL", () => {
    const p = new MarkerParser(NONCE);
    const beginST = enc.encode(`\x1b]133;C;ledge=${NONCE}:1\x1b\\`);
    const events = p.feed(join(beginST, bytes("x"), end("1", 0)));
    expect(events.map((e) => e.type)).toEqual(["began", "output", "ended"]);
    expect(outputText(events)).toBe("x");
  });

  test("output arriving in several reads is emitted per read, in order", () => {
    const p = new MarkerParser(NONCE);
    const e1 = p.feed(begin("1"));
    const e2 = p.feed(bytes("aaa"));
    const e3 = p.feed(bytes("bbb"));
    const e4 = p.feed(end("1", 0));
    expect(e1.map((e) => e.type)).toEqual(["began"]);
    expect(outputText(e2)).toBe("aaa");
    expect(outputText(e3)).toBe("bbb");
    expect(e4.map((e) => e.type)).toEqual(["ended"]);
  });

  test("a marker split across two reads is buffered until complete", () => {
    const p = new MarkerParser(NONCE);
    const b = begin("42");
    const cut = 4; // mid-prefix
    const first = p.feed(b.subarray(0, cut));
    expect(first).toEqual([]); // nothing unambiguous yet
    const second = p.feed(join(b.subarray(cut), bytes("out"), end("42", 0)));
    expect(second.map((e) => e.type)).toEqual(["began", "output", "ended"]);
    expect(second[0]).toMatchObject({ blockId: "42" });
    expect(outputText(second)).toBe("out");
  });

  test("ignores markers whose nonce is not ours, and drops their output", () => {
    const p = new MarkerParser(NONCE);
    // A foreign begin (wrong nonce) must not open a block, so text after it is
    // treated as out-of-block noise and dropped.
    const events = p.feed(join(begin("1", "othernonce"), bytes("secret")));
    expect(events).toEqual([]);
  });

  test("only the output between C and D is kept, not surrounding noise", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(
      join(bytes("prompt% "), begin("1"), bytes("real output"), end("1", 0), bytes("next prompt% ")),
    );
    expect(outputText(events)).toBe("real output");
  });

  test("handles two blocks back to back", () => {
    const p = new MarkerParser(NONCE);
    const events = p.feed(
      join(begin("a"), bytes("A"), end("a", 0), begin("b"), bytes("B"), end("b", 1)),
    );
    expect(events.map((e) => e.type)).toEqual([
      "began",
      "output",
      "ended",
      "began",
      "output",
      "ended",
    ]);
    const ids = events.map((e) => ("blockId" in e ? e.blockId : null));
    expect(ids).toEqual(["a", "a", "a", "b", "b", "b"]);
    expect(events[5]).toMatchObject({ type: "ended", blockId: "b", exitCode: 1 });
  });

  test("reports the hook's ack, and only for our own nonce", () => {
    const p = new MarkerParser(NONCE);
    expect(p.feed(bytes(`\x1b]133;R;ledge=${NONCE}\x07`))).toEqual([{ type: "ready" }]);
    // Another Ledge on the same shell is not this one's hook.
    expect(p.feed(bytes(`\x1b]133;R;ledge=someone-else\x07`))).toEqual([]);
  });

  test("the ack is not output, and does not open or close a block", () => {
    const p = new MarkerParser(NONCE);
    p.feed(bytes(`\x1b]133;R;ledge=${NONCE}\x07`));
    expect(p.openBlockId).toBe(null);
    const events = p.feed(join(begin("a"), bytes("A"), end("a", 0)));
    expect(events.map((e) => e.type)).toEqual(["began", "output", "ended"]);
  });

  test("openBlockId names the block still waiting on its end marker", () => {
    // How the Bun side closes out a block whose shell died before the prompt (and
    // therefore the hook) could report it.
    const p = new MarkerParser(NONCE);
    expect(p.openBlockId).toBe(null);
    p.feed(join(begin("a"), bytes("working")));
    expect(p.openBlockId).toBe("a");
    p.feed(end("a", 0));
    expect(p.openBlockId).toBe(null);
  });
});
