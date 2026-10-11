// WebKitGTK's DMA-BUF renderer, and the Linux desktops where the shell turns
// it off before the first window.
//
// On NVIDIA's proprietary driver in an X11 session the renderer cannot
// allocate its buffers ("Failed to create GBM buffer: Invalid argument") and
// the window paints nothing (issue #15, WebKitGTK 2.52.6). With
// WEBKIT_DISABLE_DMABUF_RENDERER set, WebKit draws without it. The same driver
// under Wayland renders with it on, so that session keeps it.
import { dlopen } from "bun:ffi";
import { existsSync } from "node:fs";
import { PLATFORM } from "./ptyNative";

export const DMABUF_VAR = "WEBKIT_DISABLE_DMABUF_RENDERER";

// Present while NVIDIA's kernel module is loaded, the proprietary one and the
// open one alike. nouveau loads as its own module and leaves this absent.
const NVIDIA_MODULE = "/sys/module/nvidia";

/**
 * Whether this launch turns the DMA-BUF renderer off: Linux, NVIDIA's driver,
 * an X11 session. A value already in `env` is the user's and stands, "0"
 * included, which WebKit reads as leaving the renderer on.
 */
export function dmabufFails(platform: string, env: Record<string, string | undefined>, nvidia: boolean): boolean {
  if (platform !== "linux" || !nvidia) return false;
  if (env[DMABUF_VAR] !== undefined) return false;
  return env["XDG_SESSION_TYPE"] !== "wayland" && !env["WAYLAND_DISPLAY"];
}

/**
 * Set a variable in the C environment, the one WebKit's getenv reads. Bun
 * keeps `process.env` as its own copy, and a write there never reaches libc.
 * False when no libc took it.
 */
export function setNativeEnv(name: string, value: string): boolean {
  for (const lib of PLATFORM.libc) {
    try {
      const libc = dlopen(lib, { setenv: { args: ["cstring", "cstring", "i32"], returns: "i32" } });
      return libc.symbols.setenv(Buffer.from(`${name}\0`), Buffer.from(`${value}\0`), 1) === 0;
    } catch {
      // The next name.
    }
  }
  return false;
}

/**
 * Turn the renderer off where `dmabufFails` says to, and report whether it
 * did. `process.env` is left alone, so the daemon and every block's shell,
 * which inherit that copy, do not carry the variable to other WebKitGTK apps.
 */
export function disableDmabufRenderer(): boolean {
  if (!dmabufFails(process.platform, process.env, existsSync(NVIDIA_MODULE))) return false;
  return setNativeEnv(DMABUF_VAR, "1");
}
