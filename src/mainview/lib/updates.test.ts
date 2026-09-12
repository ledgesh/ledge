import { describe, expect, test } from "bun:test";
import type { UpdateState } from "../../shared/rpc-schema";
import { installNotice, offersCheck, step, updateNotice, type Mirror } from "./updates";

function s(phase: UpdateState["phase"], version = "", detail = ""): UpdateState {
  return { phase, version, detail };
}

const IDLE: Mirror = { state: s("idle"), asked: false };
const ASKED: Mirror = { state: s("idle"), asked: true };

describe("updateNotice", () => {
  // The one result a background check announces, because it waits on the user.
  test("a ready update is announced whether anyone asked or not", () => {
    expect(updateNotice(s("downloading", "0.1.1"), s("ready", "0.1.1"), false)?.message).toContain("0.1.1 is ready");
  });

  test("a background check that finds nothing shows nothing", () => {
    expect(updateNotice(s("checking"), s("current", "0.1.0"), false)).toBeNull();
  });

  // A laptop offline at launch fails its background check. Nobody asked, so
  // nobody should see an error strip about it.
  test("a background check that fails shows nothing", () => {
    expect(updateNotice(s("checking"), s("failed", "", "offline"), false)).toBeNull();
  });

  test("an asked check that finds nothing names the running version", () => {
    expect(updateNotice(s("checking"), s("current", "0.1.0"), true)).toEqual({
      tone: "notice",
      message: "Ledge 0.1.0 is the latest version.",
    });
  });

  test("an asked check that fails is an error", () => {
    expect(updateNotice(s("checking"), s("failed", "", "HTTP 500"), true)).toEqual({
      tone: "error",
      message: "Could not update Ledge: HTTP 500",
    });
  });

  test("an asked check that finds a build says it is downloading", () => {
    expect(updateNotice(s("checking"), s("downloading", "0.1.1"), true)?.message).toContain("Downloading Ledge 0.1.1");
  });

  test("still checking is not an answer yet", () => {
    expect(updateNotice(s("idle"), s("checking"), true)).toBeNull();
  });
});

describe("step", () => {
  test("a push that answers an asked check shows it and clears the ask", () => {
    const { mirror, notice } = step({ state: s("checking"), asked: true }, s("current", "0.1.0"), "push");
    expect(notice?.message).toBe("Ledge 0.1.0 is the latest version.");
    expect(mirror).toEqual({ state: s("current", "0.1.0"), asked: false });
  });

  // The shell pushes the check's results before it answers the request. An
  // answer of "checking" recorded after those pushes would put a finished check
  // back to "checking" and leave the ask open forever.
  test("an answer of checking is left to the pushes", () => {
    const after = step(step(ASKED, s("checking"), "push").mirror, s("current", "0.1.0"), "push").mirror;
    expect(step(after, s("checking"), "answer")).toEqual({ mirror: after, notice: null });
  });

  // A check asked while a download is already running gets no push, since
  // nothing changed. The answer is the only thing that can reply to it.
  test("an answer of downloading replies to the ask itself", () => {
    const running: Mirror = { state: s("downloading", "0.1.1"), asked: true };
    const { mirror, notice } = step(running, s("downloading", "0.1.1"), "answer");
    expect(notice?.message).toContain("Downloading Ledge 0.1.1");
    expect(mirror.asked).toBe(false);
  });

  test("a checking push keeps the ask open", () => {
    expect(step(ASKED, s("checking"), "push").mirror.asked).toBe(true);
  });

  // A window opened while an update is waiting offers Restart to Install
  // Update, but does not announce it a second time.
  test("the boot read records without a notice", () => {
    const { mirror, notice } = step(IDLE, s("ready", "0.1.1"), "boot");
    expect(notice).toBeNull();
    expect(mirror.state.phase).toBe("ready");
  });
});

describe("installNotice", () => {
  test("an install that started says nothing", () => {
    expect(installNotice(true, s("ready", "0.1.1"))).toBeNull();
  });

  test("an install that did not start says why", () => {
    expect(installNotice(false, s("failed", "", "EACCES"))).toEqual({
      tone: "error",
      message: "Could not install the update: EACCES",
    });
  });
});

describe("offersCheck", () => {
  test("is offered while this app updates and nothing is waiting", () => {
    expect(offersCheck(s("current", "0.1.0"))).toBe(true);
    expect(offersCheck(s("failed", "", "x"))).toBe(true);
  });

  // "off" is a phone or a dev build: the verb could never work there, so it is
  // absent (interactions.md §8). "ready" wears the other face.
  test("is not offered when this app does not update, or an update is ready", () => {
    expect(offersCheck(s("off"))).toBe(false);
    expect(offersCheck(s("ready", "0.1.1"))).toBe(false);
  });
});
