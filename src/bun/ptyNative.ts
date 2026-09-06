// The C trampolines the PTY cannot reach from bun:ffi alone, and the one
// declaration of their signatures (architecture.md §8). Two consumers read
// this file and must not drift: `scripts/build-native.ts` compiles the C into
// the dylib the app bundle ships, and pty.ts dlopens that dylib, or compiles
// the same text in-process with bun:ffi's TinyCC. A symbol named here but
// absent from the C is a dlopen failure at first spawn, so ptyNative.test.ts
// compares the two.
//
// The dylib is built ahead of time because TinyCC needs the system headers
// this source includes, and a machine that downloads Ledge rather than
// building it has none (architecture.md §8). The in-process compile fails
// there with "include file 'sys/ioctl.h' not found", and nothing but a console
// warning reports it. The two accounts of what that costs disagree:
// architecture.md §8 says Ctrl-C stops working in every terminal and resize
// becomes a no-op, while pty.ts's loadNative measured Ctrl-C still working and
// only resize and non-blocking writes lost.
import type { FFIFunction } from "bun:ffi";

/** The trampolines' filename on `platform`. Mach-O and ELF disagree about the
 * extension and nothing else. */
export function nativeLibName(platform: string): string {
  return platform === "darwin" ? "libledge_pty.dylib" : "libledge_pty.so";
}

/** The trampolines' filename in `dist-native/`, and in the app bundle on the
 * platform that has one. */
export const NATIVE_LIB = nativeLibName(process.platform);

/**
 * The subdirectory one target's prebuilt trampolines sit in inside a published
 * package (`lib/native/<this>/<NATIVE_LIB>`).
 *
 * A published package carries every target at once (npmPackage.ts,
 * NATIVE_TARGETS), because npm installs one tarball on whatever machine runs
 * the install. Each library is 33KB. A bigger one would earn per-platform
 * optional dependencies; at this size they are four more packages to publish
 * in lockstep for no measurable saving. So the loader has to pick a target,
 * and this name is what it picks by.
 *
 * Two consumers, on different machines months apart: nativePath
 * (npmPackage.ts) puts this segment in the file path `scripts/build-npm.ts`
 * writes, and libCandidates (pty.ts) looks for the library under the same
 * name. A disagreement between them is not a crash. The server falls through
 * to the in-process compile, fails that too because the headers are missing,
 * and runs shells without the trampolines: resize is a no-op, and a write to a
 * shell that is not reading can stall (pty.ts, loadNative).
 */
export function nativeDir(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}

/** This machine's entry in that layout. */
export const NATIVE_DIR = nativeDir(process.platform, process.arch);

// What differs between the two libcs, in one place. The alternative is a
// `process.platform` test at every call site in pty.ts.
//
// These three fields are the whole difference, and only POSIX_SPAWN_SETSID is
// a value rather than a name. The rest of what pty.ts calls is POSIX and
// identical: openpty, ttyname, poll, killpg, tcgetpgrp, the whole posix_spawn
// family, and O_RDWR, POLLIN and struct pollfd's layout (0x2, 0x1, 8 bytes on
// both). TIOCSWINSZ does differ (0x80087467 vs 0x5414), but ioctl goes through
// the trampoline and the C compiler substitutes the right value there, so
// TIOCSWINSZ needs no entry here. That is a second reason for the trampoline
// beyond the variadic one.
//
// The floor is glibc 2.29 (Debian 11, Ubuntu 20.04, RHEL 9), set by
// posix_spawn_file_actions_addchdir_np. musl is out of scope: it has no
// addchdir_np at all, which is `architecture.md` §8's debian-slim rule seen
// from the other side.
export const PLATFORM = process.platform === "darwin"
  ? {
    libc: ["libSystem.B.dylib"],
    // openpty is libutil's on glibc, and libutil was folded into libc.so.6 in
    // 2.34 (2021). A modern Debian finds it in the first candidate, Ubuntu
    // 20.04 in the second. openpty gets its own dlopen handle rather than a
    // place in a bigger table, because dlopen resolves eagerly: one missing
    // name would take every symbol down with it.
    ptyLib: ["libSystem.B.dylib"],
    // BSD's flag. glibc's has a different value, so one shared constant would
    // silently set some other attribute on the wrong platform.
    POSIX_SPAWN_SETSID: 0x0400,
  }
  : {
    libc: ["libc.so.6", "libc.so"],
    ptyLib: ["libc.so.6", "libutil.so.1"],
    POSIX_SPAWN_SETSID: 0x0080,
  };

// ledge_spawn_tty runs login_tty (setsid, TIOCSCTTY, dup onto 0/1/2) in the
// child, between fork and exec. That gives the shell a controlling terminal,
// which is what makes ^C reach it: a tty turns ^C into SIGINT only for its
// foreground process group, and it has such a group only once some process has
// claimed it. On macOS the claim needs an explicit ioctl(TIOCSCTTY), since the
// "first tty a session leader opens becomes its ctty" rule is System V and
// Linux, not BSD. posix_spawn has no file action for an ioctl, so
// POSIX_SPAWN_SETSID alone produced a session leader with no controlling
// terminal: `stty` reported isig on and ^C did nothing.
//
// The fork is safe here even though pty.ts's header warns about fork() under
// Bun. That warning is about forking into JS, and this child touches nothing
// but syscalls before execve replaces the image.
//
// ledge_set_winsize is a fixed-arity ioctl(fd, TIOCSWINSZ, &winsize), which is
// how a live pty is resized. It is C because ioctl is variadic and bun:ffi
// mis-marshals variadic calls on arm64 (pty.ts's header). The ioctl also
// raises SIGWINCH on the child, so zsh and any running program re-read the new
// size.
//
// ledge_set_nonblock wraps fcntl for the same variadic reason, and pty.ts's
// write path is why it exists: a blocking write to a pty master can wait
// forever. A tty in canonical mode holds input a line at a time, so a line
// longer than its buffer can never be completed and never be read, and the
// writer sleeps in the kernel with the whole main process behind it. Every
// shell switches to raw mode, where no such limit exists, but a spawn writes
// before the child has done that, and a remote block's body arrives as one
// long line. O_NONBLOCK turns that wait into EAGAIN, which pty.ts can queue
// and retry.
//
// The one `#if` in the includes is login_tty's two homes: <util.h> on BSD, and
// <utmp.h> on glibc, whose <pty.h> holds openpty and forkpty instead
// (architecture.md §8).
export const NATIVE_C = `#include <fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#if defined(__linux__)
#include <pty.h>
#include <utmp.h>
#else
#include <util.h>
#endif
#include <unistd.h>

int ledge_spawn_tty(int slave_fd, int master_fd, const char *cwd,
                    const char *path, char *const argv[], char *const envp[]) {
  pid_t pid = fork();
  if (pid != 0) return (int)pid;
  close(master_fd);
  if (login_tty(slave_fd) < 0) _exit(126);
  if (cwd && cwd[0] && chdir(cwd) != 0) _exit(125);
  execve(path, argv, envp);
  _exit(127);
  return 0;
}

int ledge_set_winsize(int fd, unsigned short cols, unsigned short rows) {
  struct winsize ws;
  ws.ws_row = rows;
  ws.ws_col = cols;
  ws.ws_xpixel = 0;
  ws.ws_ypixel = 0;
  return ioctl(fd, TIOCSWINSZ, &ws);
}

int ledge_set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
`;

// One descriptor set for both load paths: dlopen and cc take the same FFIType
// vocabulary, so the dylib and the in-process compile cannot disagree about a
// signature.
export const NATIVE_SYMBOLS = {
  ledge_spawn_tty: {
    args: ["int", "int", "ptr", "ptr", "ptr", "ptr"],
    returns: "int",
  },
  ledge_set_winsize: { args: ["int", "u16", "u16"], returns: "int" },
  ledge_set_nonblock: { args: ["int"], returns: "int" },
} satisfies Record<string, FFIFunction>;

/** The function names the C source defines, in source order. The invariant
 * test compares them against NATIVE_SYMBOLS' keys. Nothing else parses C. */
export function definedSymbols(source: string): string[] {
  return [...source.matchAll(/^\w[\w *]*?\b(\w+)\s*\(/gm)].map((m) => m[1]);
}
