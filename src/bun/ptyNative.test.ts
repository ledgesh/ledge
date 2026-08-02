import { describe, expect, test } from "bun:test";
import { NATIVE_C, NATIVE_LIB, NATIVE_SYMBOLS, PLATFORM, definedSymbols } from "./ptyNative";

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
  // The copy map (electrobun.config.ts) spells the macOS name literally,
  // because a Mac app bundle is the only thing it builds.
  test("the library is named for what dlopen expects", () => {
    expect(NATIVE_LIB).toBe(process.platform === "darwin" ? "libledge_pty.dylib" : "libledge_pty.so");
  });

  // login_tty is <util.h> on BSD and <utmp.h> on glibc, and a source that
  // includes only one of them compiles on one platform and fails on the other
  // — which, in the fallback path, is a terminal with no Ctrl-C rather than a
  // build error anyone sees.
  test("the C reaches login_tty on both libcs", () => {
    expect(NATIVE_C).toContain("#if defined(__linux__)");
    expect(NATIVE_C).toContain("#include <pty.h>");
    expect(NATIVE_C).toContain("#include <utmp.h>");
    expect(NATIVE_C).toContain("#include <util.h>");
  });

  // Every other constant pty.ts holds agrees across the two libcs, which is
  // why they are still literals there. This one does not, and the failure it
  // would cause is silent: an unrecognized flag bit sets some other attribute,
  // the child gets no session of its own, and Ctrl-C goes nowhere.
  test("the spawn flag is the one this platform's libc means", () => {
    expect(PLATFORM.POSIX_SPAWN_SETSID).toBe(process.platform === "darwin" ? 0x0400 : 0x0080);
  });

  test("openpty is looked for where the platform keeps it", () => {
    // Not the same list as `libc`: glibc below 2.34 keeps openpty in libutil,
    // and dlopen resolving a table all at once means one absent name would
    // take read(), write() and poll() with it.
    expect(PLATFORM.ptyLib.length).toBeGreaterThan(0);
    if (process.platform === "darwin") expect(PLATFORM.ptyLib).toEqual(PLATFORM.libc);
    else expect(PLATFORM.ptyLib).toContain("libutil.so.1");
  });
});
