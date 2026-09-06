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
    // An interrupt aborts this line, so anything on it that reports the exit
    // code would never run. Only the start marker goes here. The end marker
    // comes from the prompt hook.
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
    // This line is the first thing ever written to a new pty, and on Linux
    // the line discipline can swallow its first byte with no error. One byte
    // short, the definition names `_ledge_precmd` while the registration
    // names `__ledge_precmd`, so every block begins and none ever ends. The
    // leading newline is that byte. The definition starts on the next line.
    const init = markerInit(NONCE);
    expect(init.startsWith("\n")).toBe(true);
    expect(init.slice(1).startsWith("__ledge_precmd()")).toBe(true);
    // The expendable byte has to be one the shell does nothing with: losing
    // part of a padding command would leave the rest of that command to run.
    expect(init.indexOf("\n")).toBe(0);
  });

  // The ack is what makes a lost hook detectable. The C marker rides on the
  // block's own line, so it arrives whatever happened to the hook. Without an
  // ack, a shell that never installed one looks like a working shell until
  // the block fails to end. bun/inlinePool.ts sends the init line again with
  // the next block when no ack has arrived.
  test("the hook says so once it is installed", () => {
    const init = markerInit(NONCE);
    expect(init).toContain(`133;R;ledge=${NONCE}`);
  });

  test("the ack is the last thing on the line, so no damage can outlive it", () => {
    // Anything that truncates this line takes the ack with it. Put earlier, a
    // cut after the ack and before the registration would report a hook that
    // is not there. A hook reported and missing is worse than no ack at all.
    const init = markerInit(NONCE);
    expect(init.trimEnd().endsWith(`printf '\\033]133;R;ledge=${NONCE}\\a'`)).toBe(true);
    expect(init.indexOf("133;R;")).toBeGreaterThan(init.indexOf("precmd_functions"));
    expect(init.indexOf("133;R;")).toBeGreaterThan(init.indexOf("PROMPT_COMMAND="));
  });

  test("the hook stays quiet when no block is running", () => {
    // Prompts happen for reasons other than blocks. Without this guard every
    // one of them would emit an end marker for whatever ran last.
    expect(markerInit(NONCE)).toContain('[ -n "$__ledge_id" ] || return');
  });

  test("a block's id is cleared once reported, so it is reported once", () => {
    expect(markerInit(NONCE)).toContain("__ledge_id=; }");
  });

  test("the hook registers in zsh and bash alike", () => {
    // Remote inline shells are bash (bun/remoteSpawn.ts), local ones zsh. One
    // init line has to install the hook in either, so its body stays POSIX. A
    // zsh-ism errors in bash without stopping the line, which runs on
    // statement by statement. The hook goes unregistered and no end marker
    // ever arrives, leaving every remote block on "Running".
    const init = markerInit(NONCE);
    expect(init).toContain("precmd_functions+=(__ledge_precmd)");
    expect(init).toContain('PROMPT_COMMAND="__ledge_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"');
    expect(init).not.toContain("[[");
  });

  test("zsh's partial-line mark is off, and only inside the zsh branch", () => {
    // PROMPT_SP prints a reverse-video `%` (plus padding and a CR) before
    // every prompt, ahead of precmd, so it lands inside the C..D window the
    // parser keeps. Its self-erase is sized to the pty's winsize, and a
    // winsize that disagrees with the panel's grid leaves the `%` as a stray
    // line under the output. Nothing reads this shell's prompt, so the
    // option only costs here.
    const init = markerInit(NONCE);
    expect(init).toContain("unsetopt PROMPT_SP");
    // `unsetopt` is a zsh builtin. If it reached a remote bash it would be a
    // command-not-found on the init line, the same line that installs the
    // end-marker hook.
    const zshBranch = init.slice(init.indexOf('if [ -n "$ZSH_VERSION" ]'), init.indexOf("else "));
    expect(zshBranch).toContain("unsetopt PROMPT_SP");
  });

  // SUPPORTED_SHELLS (bun/spawnParams.ts) lists the shells Ledge resolves to,
  // and it must match the shells this init installs a hook for. A shell added
  // to that list without a branch here spawns without complaint and then
  // never ends a block: no output, no exit code. This test pins the pairing.
  test("the supported shells are exactly the ones this init installs a hook for", () => {
    const init = markerInit(NONCE);
    expect([...SUPPORTED_SHELLS]).toEqual(["zsh", "bash"]);
    // zsh registers the hook through its own hook array.
    expect(init).toContain("precmd_functions+=(__ledge_precmd)");
    // bash registers it through PROMPT_COMMAND, the variable only bash runs
    // before each prompt. dash and fish have neither, so neither is on the
    // list.
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
    // bun/inlinePool.ts reads openBlockId to close out a block whose shell
    // exited before the prompt (and therefore the hook) could report its end.
    // It does this when a shell exits and when a session restarts, falling
    // back to slot.activeRun for a shell that died before the C marker echoed
    // back.
    const p = new MarkerParser(NONCE);
    expect(p.openBlockId).toBe(null);
    p.feed(join(begin("a"), bytes("working")));
    expect(p.openBlockId).toBe("a");
    p.feed(end("a", 0));
    expect(p.openBlockId).toBe(null);
  });
});
