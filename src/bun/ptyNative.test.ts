import { describe, expect, test } from "bun:test";
import { NATIVE_C, NATIVE_LIB, NATIVE_SYMBOLS, definedSymbols } from "./ptyNative";

describe("the PTY trampolines' declarations", () => {
  // The invariant that matters: dlopen resolves every name in NATIVE_SYMBOLS
  // eagerly, so a symbol declared here but not defined in the C is not a quiet
  // gap — it is every terminal losing Ctrl-C the moment the dylib is present.
  // A definition with no declaration is the milder half (dead C), and pinning
  // the sets equal catches both directions of drift.
  test("the C defines exactly the symbols declared for it", () => {
    expect(new Set(definedSymbols(NATIVE_C))).toEqual(new Set(Object.keys(NATIVE_SYMBOLS)));
  });

  test("definedSymbols reads definitions, not calls or declarations", () => {
    const src = `#include <util.h>
int wanted(int fd) {
  struct winsize ws;
  return ioctl(fd, TIOCSWINSZ, &ws);
}
`;
    expect(definedSymbols(src)).toEqual(["wanted"]);
  });

  // The build script writes this name and the copy map ships it under it;
  // pty.ts looks for it. A rename that misses one of the three degrades
  // silently to the in-process compile, which is invisible on a dev machine.
  test("the library is named for what dlopen expects", () => {
    expect(NATIVE_LIB).toBe("libledge_pty.dylib");
  });
});
