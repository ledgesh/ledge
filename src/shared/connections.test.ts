// The half of a connection both clients hold (remote.md §8).
//
// These are the refusals that stand between a text field and ssh's argv, so
// they are tested where they live rather than through either client: the Mac
// reaches them through bun/connections.ts and the phone reaches them from the
// webview, and a rule that only one of the two enforced would be a rule the
// other one could be talked out of.
import { describe, expect, test } from "bun:test";
import { hostPart, pinFitsHost, pinnedHost, validateConnection } from "./connections";

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

  // The refusals that matter: a leading "-" reads as an ssh OPTION once the
  // destination becomes argv, and whitespace would split one argument into two.
  test.each([
    ["-oProxyCommand=touch /tmp/pwned", "an option"],
    ["laptop; rm -rf /", "a command"],
    ["dev@laptop extra", "two arguments"],
    ["", "nothing"],
  ])("a destination of %p (%s) is refused", (destination) => {
    expect(validateConnection({ ...ok, destination })).not.toBeNull();
  });
});

// keyscan takes a host; the user half of a destination is ssh's business, not
// the host key's.
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

  // Editing an address to point at another machine invalidates the pin. Keeping
  // it would refuse every later connection with a message about a CHANGED host
  // key, which is the most alarming possible wording for "you typed a new name".
  test("a pin does not follow a connection to another host", () => {
    expect(pinFitsHost("laptop ssh-ed25519 AAAA", "dev@laptop")).toBe(true);
    // The user half is not the host half: changing the account keeps the pin.
    expect(pinFitsHost("laptop ssh-ed25519 AAAA", "ledge@laptop")).toBe(true);
    expect(pinFitsHost("laptop ssh-ed25519 AAAA", "dev@vps")).toBe(false);
  });

  // "Your own ssh already trusts this host" is a pin too — in the user's file
  // rather than Ledge's — so there is nothing here to invalidate.
  test("no pin of Ledge's own fits anywhere", () => {
    expect(pinFitsHost("", "dev@anywhere")).toBe(true);
    expect(pinFitsHost("ssh-ed25519 AAAA", "dev@anywhere")).toBe(true);
  });
});
