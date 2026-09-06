import { describe, expect, test } from "bun:test";
import { NATIVE_C, NATIVE_LIB, NATIVE_SYMBOLS, PLATFORM, definedSymbols } from "./ptyNative";

describe("the PTY trampolines' declarations", () => {
  // dlopen resolves every name in NATIVE_SYMBOLS at once, so a symbol declared
  // here but not defined in the C makes the whole load fail at first spawn.
  // The in-process compile needs the same symbol and cannot find it either.
  // The PTY then runs with no resize and no O_NONBLOCK on the master (pty.ts,
  // loadNative). A definition with no declaration is only dead C. Pinning the
  // sets equal catches both directions of drift.
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

  // Three places use this name: scripts/build-native.ts writes the library
  // under it, electrobun.config.ts's copy map ships it, and pty.ts looks for
  // it. A rename that misses one of them degrades silently to the in-process
  // compile, which succeeds on a dev machine. The copy map spells the macOS
  // name literally, because a Mac app bundle is the only thing it builds.
  test("the library is named for what dlopen expects", () => {
    expect(NATIVE_LIB).toBe(process.platform === "darwin" ? "libledge_pty.dylib" : "libledge_pty.so");
  });

  // login_tty is declared in <util.h> on BSD and in <utmp.h> on glibc. A
  // source that includes only one of them compiles on one platform and fails
  // on the other. On the in-process compile path nobody sees a build error:
  // the failure shows up at first spawn, as the console warning pty.ts's
  // loadNative prints when it has no trampolines.
  test("the C reaches login_tty on both libcs", () => {
    expect(NATIVE_C).toContain("#if defined(__linux__)");
    expect(NATIVE_C).toContain("#include <pty.h>");
    expect(NATIVE_C).toContain("#include <utmp.h>");
    expect(NATIVE_C).toContain("#include <util.h>");
  });

  // Every other constant pty.ts defines has the same value on both libcs, so
  // those stay literals there. This one differs. On glibc, 0x0400 is not a
  // flag at all: posix_spawnattr_setflags returns EINVAL, pty.ts ignores that
  // return, and the child of its fallback spawn gets no session and no
  // controlling terminal, with no error. On macOS, 0x0080 is
  // POSIX_SPAWN_START_SUSPENDED, so the shell spawns stopped.
  test("the spawn flag is the one this platform's libc means", () => {
    expect(PLATFORM.POSIX_SPAWN_SETSID).toBe(process.platform === "darwin" ? 0x0400 : 0x0080);
  });

  test("openpty is looked for where the platform keeps it", () => {
    // Not the same list as `libc`: glibc below 2.34 keeps openpty in libutil.
    // That is why pty.ts dlopens openpty on a handle of its own. dlopen
    // resolves a table all at once, so an absent openpty in the libc table
    // would take read(), write() and poll() down with it.
    expect(PLATFORM.ptyLib.length).toBeGreaterThan(0);
    if (process.platform === "darwin") expect(PLATFORM.ptyLib).toEqual(PLATFORM.libc);
    else expect(PLATFORM.ptyLib).toContain("libutil.so.1");
  });
});
