// The half of a connection both clients hold (remote.md §8): the refusals
// that stand between a text field and ssh's argv. They are tested here rather
// than through either client. The Mac reaches them through
// bun/connections.ts, and the phone reaches them from the webview. A client
// that skipped one of these rules would accept what the other refuses.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PORT,
  hostPart,
  knownHostsHost,
  parsePort,
  pinFitsHost,
  pinnedHost,
  PORT_UNSET,
  validateConnection,
} from "./connections";

describe("validating what someone typed", () => {
  const ok = { name: "Laptop", destination: "dev@laptop", keyPath: "" };

  test("a plain destination is accepted", () => {
    expect(validateConnection(ok)).toBeNull();
    expect(validateConnection({ ...ok, destination: "prod-01" })).toBeNull();
    expect(validateConnection({ ...ok, destination: "laptop.local" })).toBeNull();
  });

  test.each([
    ["", "nothing"],
    ["   ", "only spaces"],
  ])("a name of %p (%s) is refused", (name) => {
    expect(validateConnection({ ...ok, name })).toContain("name");
  });

  // A leading "-" reads as an ssh option once the destination becomes argv.
  // Whitespace splits one argument into two.
  test.each([
    ["-oProxyCommand=touch /tmp/pwned", "an option"],
    ["laptop; rm -rf /", "a command"],
    ["dev@laptop extra", "two arguments"],
    ["", "nothing"],
  ])("a destination of %p (%s) is refused", (destination) => {
    expect(validateConnection({ ...ok, destination })).not.toBeNull();
  });
});

// keyscan takes a host, so hostPart drops the user half of a destination. A
// host key does not depend on which account connects.
describe("the host half of a destination", () => {
  test.each([
    ["dev@laptop", "laptop"],
    ["laptop", "laptop"],
    ["dev@user@bastion", "bastion"],
  ])("%p scans %p", (destination, host) => {
    expect(hostPart(destination)).toBe(host);
  });
});

describe("a pin belongs to one host", () => {
  test("the host is the known_hosts line's first field", () => {
    expect(pinnedHost("laptop ssh-ed25519 AAAAC3Nza")).toBe("laptop");
  });

  // The phone pins the key's two fields and no hostname: there is no
  // known_hosts file there for a hostname to index (ios.md §3).
  test("a two-field pin names no host", () => {
    expect(pinnedHost("ssh-ed25519 AAAAC3Nza")).toBe("");
    expect(pinnedHost("")).toBe("");
  });

  // Editing an address to point at another machine invalidates the pin.
  // Keeping it would refuse every later connection with a changed-host-key
  // warning, which reads as an attack when the user only edited the address.
  test("a pin does not follow a connection to another host", () => {
    expect(pinFitsHost("laptop ssh-ed25519 AAAA", "dev@laptop")).toBe(true);
    // The user half is not the host half: changing the account keeps the pin.
    expect(pinFitsHost("laptop ssh-ed25519 AAAA", "ledge@laptop")).toBe(true);
    expect(pinFitsHost("laptop ssh-ed25519 AAAA", "dev@vps")).toBe(false);
  });

  // Neither pin names a host, so there is nothing here to invalidate. An
  // empty pin means Ledge stored none because the user's own ssh already
  // trusts the host. A two-field pin is a phone's, and pinFitsHost cannot
  // check it (see pinnedHost above).
  test("no pin of Ledge's own fits anywhere", () => {
    expect(pinFitsHost("", "dev@anywhere")).toBe(true);
    expect(pinFitsHost("ssh-ed25519 AAAA", "dev@anywhere")).toBe(true);
  });

  // known_hosts indexes a non-default port as `[host]:port`. The pin is taken
  // and compared in that shape, or it matches nothing at connect time.
  test("a port is part of which host a pin belongs to", () => {
    expect(pinFitsHost("[laptop]:2222 ssh-ed25519 AAAA", "dev@laptop", 2222)).toBe(true);
    // The same machine on another port is a separate known_hosts entry, and can
    // offer a different key.
    expect(pinFitsHost("[laptop]:2222 ssh-ed25519 AAAA", "dev@laptop", 2022)).toBe(false);
    expect(pinFitsHost("[laptop]:2222 ssh-ed25519 AAAA", "dev@laptop", PORT_UNSET)).toBe(false);
    expect(pinFitsHost("laptop ssh-ed25519 AAAA", "dev@laptop", 2222)).toBe(false);
  });
});

describe("ports", () => {
  // ssh writes the bare host for the default port, so 22 never appears in a
  // known_hosts entry. An unset port leaves the choice to ssh and never reaches
  // known_hosts at all.
  test("known_hosts spells a non-default port and only that", () => {
    expect(knownHostsHost("dev@laptop", PORT_UNSET)).toBe("laptop");
    expect(knownHostsHost("dev@laptop", DEFAULT_PORT)).toBe("laptop");
    expect(knownHostsHost("dev@laptop", 2222)).toBe("[laptop]:2222");
    expect(knownHostsHost("laptop", 2222)).toBe("[laptop]:2222");
  });

  // An empty field parses as unset, which is the ordinary case. A typo parses
  // as null, which the caller refuses: the typo has to reach the user rather
  // than silently become 22.
  test("an empty port is unset; anything that is not a port is null", () => {
    expect(parsePort("")).toBe(PORT_UNSET);
    expect(parsePort("  ")).toBe(PORT_UNSET);
    expect(parsePort("2222")).toBe(2222);
    expect(parsePort(" 22 ")).toBe(22);
    expect(parsePort("22x")).toBeNull();
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("1e3")).toBeNull();
  });

  test("a port a form could not have produced is refused with a reason", () => {
    const fields = { name: "VPS", destination: "ledge@vps", keyPath: "" };
    expect(validateConnection({ ...fields, port: 2222 })).toBeNull();
    // Unset passes: it means ssh decides, not that something is missing.
    expect(validateConnection({ ...fields, port: PORT_UNSET })).toBeNull();
    expect(validateConnection({ ...fields, port: 70000 })).toContain("1 to 65535");
    expect(validateConnection({ ...fields, port: 22.5 })).toContain("1 to 65535");
  });
});
