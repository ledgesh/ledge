// The two C trampolines the PTY cannot do from bun:ffi alone, and the one
// declaration of their signatures. Kept apart from pty.ts because there are
// two consumers and they must not drift: `scripts/build-native.ts` compiles
// this source into the dylib the app bundle ships, and pty.ts loads that dylib
// (falling back to compiling the same text in-process with bun:ffi's TinyCC).
// A symbol named here but absent from the C is a dlopen failure at first
// spawn, which is why the pair lives in one file with an invariant test.
//
// Why a build-time dylib at all: TinyCC needs the SYSTEM HEADERS this source
// includes, and macOS keeps those in the SDK — a Mac without Xcode or the
// Command Line Tools has no /usr/include, so the in-process compile fails with
// "include file 'sys/ioctl.h' not found". That machine is a plausible first
// launch (Ledge is downloaded, not built), and the failure is quiet and awful:
// Ctrl-C stops working in every terminal and resize becomes a no-op. Compiling
// on OUR machine, where the SDK is a build requirement anyway, moves the
// dependency off the user's.
import type { FFIFunction } from "bun:ffi";

/** The dylib's filename in the bundle and in `dist-native/`. */
export const NATIVE_LIB = "libledge_pty.dylib";

// Spawning the shell so that Ctrl-C works.
//
// A tty only turns ^C into SIGINT for its foreground process group, and it only
// has one if some process has claimed it as its CONTROLLING terminal. On macOS
// that claim is an explicit ioctl(TIOCSCTTY) - the "first tty a session leader
// opens becomes its ctty" rule is System V/Linux, not BSD - and posix_spawn has no
// file action for an ioctl. So POSIX_SPAWN_SETSID gave us a session leader with no
// controlling terminal: `stty` reported isig on, and ^C still did nothing, because
// the line discipline had nobody to signal.
//
// login_tty() is exactly that missing step (setsid + TIOCSCTTY + dup onto 0/1/2),
// but it has to run in the child, between fork and exec. Hence this trampoline.
// pty.ts's header warning about fork() under Bun holds for forking into JS; here
// the child touches nothing but syscalls before execve replaces the image, which
// is the same contract posix_spawn keeps inside libc.
//
// Resizing a live pty means ioctl(fd, TIOCSWINSZ, &winsize), but ioctl is
// variadic and bun:ffi mis-marshals variadic calls on arm64 (pty.ts's header),
// so ledge_set_winsize is a fixed-arity wrapper around it. ioctl(TIOCSWINSZ)
// also raises SIGWINCH on the child, so zsh and any running program re-read the
// new size.
//
// ledge_set_nonblock is there for the same variadic reason, and pty.ts's write
// path is why: a blocking write to a pty master can wait forever. A tty in
// canonical mode holds input a line at a time, so a line longer than its buffer
// can never be completed and never be read, and the writer sleeps in the kernel
// with the whole main process behind it. Every shell switches to raw mode where
// no such limit exists, but a spawn writes before the child has done that, and
// a remote block's body rides in on one long line. O_NONBLOCK turns that wait
// into EAGAIN, which pty.ts can queue and retry.
export const NATIVE_C = `#include <fcntl.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <util.h>
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
 * test compares this against NATIVE_SYMBOLS' keys; nothing else parses C. */
export function definedSymbols(source: string): string[] {
  return [...source.matchAll(/^\w[\w *]*?\b(\w+)\s*\(/gm)].map((m) => m[1]);
}
