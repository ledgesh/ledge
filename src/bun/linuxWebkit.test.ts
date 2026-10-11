import { describe, expect, test } from "bun:test";
import { CString, dlopen } from "bun:ffi";
import { DMABUF_VAR, dmabufFails, setNativeEnv } from "./linuxWebkit";
import { PLATFORM } from "./ptyNative";

describe("whether the DMA-BUF renderer is turned off", () => {
  const x11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };

  test("it is on Linux with NVIDIA's driver in an X11 session", () => {
    expect(dmabufFails("linux", x11, true)).toBe(true);
  });

  test("a session that names no type and no Wayland display counts as X11", () => {
    expect(dmabufFails("linux", { DISPLAY: ":0" }, true)).toBe(true);
  });

  test("it is not without NVIDIA's driver", () => {
    expect(dmabufFails("linux", x11, false)).toBe(false);
  });

  test("it is not in a Wayland session, named either way", () => {
    expect(dmabufFails("linux", { XDG_SESSION_TYPE: "wayland" }, true)).toBe(false);
    expect(dmabufFails("linux", { XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" }, true)).toBe(false);
  });

  test("it is not off Linux", () => {
    expect(dmabufFails("darwin", x11, true)).toBe(false);
    expect(dmabufFails("win32", x11, true)).toBe(false);
  });

  test("a value the user set stands, 0 included", () => {
    expect(dmabufFails("linux", { ...x11, [DMABUF_VAR]: "0" }, true)).toBe(false);
    expect(dmabufFails("linux", { ...x11, [DMABUF_VAR]: "1" }, true)).toBe(false);
  });
});

describe("a variable set in the C environment", () => {
  const libc = dlopen(PLATFORM.libc[0]!, { getenv: { args: ["cstring"], returns: "ptr" } });
  const getenv = (name: string): string | null => {
    const at = libc.symbols.getenv(Buffer.from(`${name}\0`));
    return at ? new CString(at).toString() : null;
  };

  test("is what libc's getenv answers, and process.env does not carry it", () => {
    const name = "LEDGE_TEST_NATIVE_ENV";
    expect(getenv(name)).toBeNull();
    expect(setNativeEnv(name, "1")).toBe(true);
    expect(getenv(name)).toBe("1");
    expect(process.env[name]).toBeUndefined();
  });

  test("a write to process.env does not reach it, which is why setNativeEnv exists", () => {
    const name = "LEDGE_TEST_PROCESS_ENV";
    process.env[name] = "1";
    try {
      expect(getenv(name)).toBeNull();
    } finally {
      delete process.env[name];
    }
  });
});
