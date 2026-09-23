import { describe, expect, test } from "bun:test";
import { cleanLoginEnv, dedupePath, envCommand, parseEnvOutput, RESOLVING_VAR, withUtf8Locale } from "./loginEnv";

const N = "ledge-env-n";
const wrap = (body: string, before = "", after = "") => `${before}${N}<${body}>${N}${after}`;

describe("parseEnvOutput", () => {
  test("reads NUL-separated entries between the markers", () => {
    expect(parseEnvOutput(wrap("A=1\0B=two\0"), N)).toEqual({ A: "1", B: "two" });
  });

  test("ignores whatever a profile printed around the markers", () => {
    expect(parseEnvOutput(wrap("A=1\0", "Welcome back!\n", "bye\n"), N)).toEqual({ A: "1" });
  });

  test("keeps newlines and equals signs inside a value", () => {
    expect(parseEnvOutput(wrap("A=x=y\nz\0"), N)).toEqual({ A: "x=y\nz" });
  });

  test("returns null when the markers are missing", () => {
    expect(parseEnvOutput("env: illegal option -- 0\n", N)).toBeNull();
    expect(parseEnvOutput(`${N}<A=1\0`, N)).toBeNull();
  });

  test("the command's markers are the ones the parser looks for", () => {
    expect(envCommand(N)).toContain(`'${N}<'`);
    expect(envCommand(N)).toContain(`'>${N}'`);
  });
});

describe("cleanLoginEnv", () => {
  test("drops the resolving shell's own bookkeeping", () => {
    const env = cleanLoginEnv({ PWD: "/x", OLDPWD: "/y", SHLVL: "1", _: "/usr/bin/env", [RESOLVING_VAR]: "1", HOME: "/h" });
    expect(env).toEqual({ HOME: "/h" });
  });

  test("removes repeated PATH directories, keeping each at its first position", () => {
    expect(cleanLoginEnv({ PATH: "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/bin" }).PATH).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });
});

describe("dedupePath", () => {
  test("drops empty entries", () => {
    expect(dedupePath(":/a::/b:")).toBe("/a:/b");
  });
});

describe("withUtf8Locale", () => {
  const all = () => true;
  const none = () => false;

  test("an env with no locale gets LANG from the Mac's region", () => {
    expect(withUtf8Locale({ PATH: "/bin" }, "pt_BR", all)).toEqual({ PATH: "/bin", LANG: "pt_BR.UTF-8" });
  });

  test("a region modifier after @ is dropped", () => {
    expect(withUtf8Locale({}, "en_GB@rg=uszzzz", all).LANG).toBe("en_GB.UTF-8");
  });

  test("a region with no installed UTF-8 locale falls back to en_US.UTF-8", () => {
    expect(withUtf8Locale({}, "xx_YY", none).LANG).toBe("en_US.UTF-8");
  });

  test("no region, or one that is not a region identifier, falls back to en_US.UTF-8", () => {
    expect(withUtf8Locale({}, null, all).LANG).toBe("en_US.UTF-8");
    expect(withUtf8Locale({}, "../../etc", all).LANG).toBe("en_US.UTF-8");
  });

  test("any locale variable the account set is left alone", () => {
    const set: Record<string, string>[] = [{ LANG: "C" }, { LC_CTYPE: "UTF-8" }, { LC_ALL: "de_DE.UTF-8" }];
    for (const env of set) {
      expect(withUtf8Locale(env, "en_US", all)).toEqual(env);
    }
  });

  test("an empty locale variable counts as unset", () => {
    expect(withUtf8Locale({ LANG: "" }, "en_US", all).LANG).toBe("en_US.UTF-8");
  });
});
