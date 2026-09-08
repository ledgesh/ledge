// The vault's crypto and its two text surgeries (the head/body split and the
// `locked:` frontmatter line), against the scratch app home where .vault.json
// lands (the preload's LEDGE_NOTES_ROOT). The envelope round trips cover
// locking.md §2: what seals must open, what is tampered with must refuse, and
// a locked note must open with the passphrase and its own header on a machine
// that has no vault file. Syncing depends on that last property.
import { beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { APP_HOME } from "./workspaces";
import {
  createVault,
  loadVault,
  lockVault,
  mintLockedHeader,
  openBody,
  parseLockedHeader,
  authorizedDeviceCount,
  lockVaultFor,
  resetVaultForTests,
  sealBody,
  splitHead,
  stampLockedLine,
  stripLockedLine,
  unlockVault,
  touchVault,
  vaultActivityForTests,
  VAULT_PATH,
  vaultState,
  vaultStateFor,
} from "./vault";

// Two devices, because an unlock belongs to one of them (locking.md §3a). The
// names are what the tests below read as: the Mac unlocks, and the phone is
// the other device that did not.
const MAC = "device-mac";
const PHONE = "device-phone";

if (!resolve(APP_HOME).startsWith(resolve(tmpdir()) + sep)) {
  throw new Error(`refusing to run vault tests against ${APP_HOME} — is the preload configured?`);
}

beforeEach(async () => {
  resetVaultForTests();
  await rm(VAULT_PATH, { force: true });
  await rm(`${VAULT_PATH}.bad-0`, { force: true }).catch(() => {});
});

describe("splitHead", () => {
  const cases: Array<[string, string, string]> = [
    // [text, expected head, expected body]
    ["---\ncwd: /x\n---\n# Title\n\nbody\n", "---\ncwd: /x\n---\n# Title\n", "\nbody\n"],
    ["---\ncwd: /x\n---\n\n# Title\nbody\n", "---\ncwd: /x\n---\n\n# Title\n", "body\n"],
    ["# Title\n\nbody\n", "# Title\n", "\nbody\n"],
    ["# Title", "# Title", ""],
    ["plain prose\nmore\n", "", "plain prose\nmore\n"],
    // A block with no H1 after it: the head is the block alone and the blank
    // run is body, matching headingOf. headingOf skips those blanks to look
    // for an H1, and no H1 follows them here.
    ["---\ncwd: /x\n---\n\nprose\n", "---\ncwd: /x\n---\n", "\nprose\n"],
    ["", "", ""],
  ];
  test("head + body round-trips byte-for-byte, and the head is exactly the labeling read", () => {
    for (const [text, head, body] of cases) {
      const s = splitHead(text);
      expect(s.head).toBe(head);
      expect(s.body).toBe(body);
      expect(s.head + s.body).toBe(text);
    }
  });
});

describe("locked: line surgery", () => {
  test("stamp replaces an existing line in place and drops stray duplicates", () => {
    const text = "---\ncwd: /x\nlocked: old\ntags: a\nlocked: older\n---\n# T\n";
    expect(stampLockedLine(text, "new")).toBe("---\ncwd: /x\nlocked: new\ntags: a\n---\n# T\n");
  });
  test("stamp inserts as the block's first line when none exists", () => {
    expect(stampLockedLine("---\ncwd: /x\n---\n# T\n", "v")).toBe("---\nlocked: v\ncwd: /x\n---\n# T\n");
  });
  test("stamp grows a block on a note that has none", () => {
    expect(stampLockedLine("# T\n\nbody\n", "v")).toBe("---\nlocked: v\n---\n# T\n\nbody\n");
  });
  test("strip removes the line, and an emptied block goes entirely", () => {
    expect(stripLockedLine("---\nlocked: v\ncwd: /x\n---\n# T\n")).toBe("---\ncwd: /x\n---\n# T\n");
    expect(stripLockedLine("---\nlocked: v\n---\n# T\n\nbody\n")).toBe("# T\n\nbody\n");
    expect(stripLockedLine("# T\n\nbody\n")).toBe("# T\n\nbody\n");
  });
  test("strip leaves a block it removed nothing from, even an empty one", () => {
    // The first shape is what frontmatterEdit.ts inserts on a note with no
    // block. An autosave landing before the user types must not delete it.
    expect(stripLockedLine("---\n\n---\n# T\n")).toBe("---\n\n---\n# T\n");
    expect(stripLockedLine("---\n---\n# T\n")).toBe("---\n---\n# T\n");
    expect(stripLockedLine("---\ncwd: /x\n---\n# T\n")).toBe("---\ncwd: /x\n---\n# T\n");
  });
});

describe("vault lifecycle and the envelope", () => {
  test("create → seal → open round-trips, and a lock refuses both directions", async () => {
    await createVault("correct horse", MAC);
    expect(vaultState()).toBe("unlocked");
    const header = mintLockedHeader();
    parseLockedHeader(header); // throws if the header is malformed
    const body = "line one\n\nline two with #tag and [[Link]]\n";
    const armored = sealBody(header, body);
    expect(armored).not.toContain("line one"); // ciphertext under the base64 armor
    expect(openBody(header, armored)).toBe(body);
    expect(openBody(header, sealBody(header, ""))).toBe(""); // empty body seals too

    lockVault();
    expect(vaultState()).toBe("locked");
    expect(() => sealBody(header, body)).toThrow(/vault is locked/);
    expect(() => openBody(header, armored)).toThrow(/vault is locked/);

    expect(await unlockVault("wrong pass", MAC)).toBe(false);
    expect(vaultState()).toBe("locked");
    expect(await unlockVault("correct horse", MAC)).toBe(true);
    expect(openBody(header, armored)).toBe(body);
  });

  test("unlocking an already-unlocked vault still checks the passphrase", async () => {
    // The answer used to be an unconditional yes whenever the key was in
    // memory. No screen reached it, since the dialog opens only while the
    // vault is shut, but the RPC is the contract and scoping an unlock to a
    // caller would have turned the same shape into a way in (locking.md §3).
    await createVault("correct horse", MAC);
    expect(vaultState()).toBe("unlocked");

    expect(await unlockVault("wrong pass", MAC)).toBe(false);
    // And a wrong answer changes nothing: relocking on a typo would be a way
    // to shut somebody else's session out.
    expect(vaultState()).toBe("unlocked");

    expect(await unlockVault("correct horse", MAC)).toBe(true);
    expect(vaultState()).toBe("unlocked");
  });

  // An unlock belongs to the device it was typed on (locking.md §3a). One key
  // for the process, and a set of devices allowed to reach it: vaultState is
  // what the process holds, vaultStateFor is what one device sees.
  test("a device that did not unlock sees a locked vault", async () => {
    await createVault("correct horse", MAC);
    expect(vaultStateFor(MAC)).toBe("unlocked");
    expect(vaultStateFor(PHONE)).toBe("locked");
    // Not "none": a vault exists on this machine, so the phone is asked to
    // type the passphrase rather than to choose one.
    expect(vaultState()).toBe("unlocked");
  });

  test("a second device unlocks with the same passphrase, and a wrong one shuts nobody out", async () => {
    await createVault("correct horse", MAC);

    expect(await unlockVault("wrong pass", PHONE)).toBe(false);
    expect(vaultStateFor(PHONE)).toBe("locked");
    expect(vaultStateFor(MAC)).toBe("unlocked"); // a typo on one device is not a lock on another

    expect(await unlockVault("correct horse", PHONE)).toBe(true);
    expect(vaultStateFor(PHONE)).toBe("unlocked");
    expect(authorizedDeviceCount()).toBe(2);
  });

  test("Lock Notes shuts the device it was run on, and the key goes with the last one", async () => {
    await createVault("correct horse", MAC);
    expect(await unlockVault("correct horse", PHONE)).toBe(true);

    // ⌘L on the Mac. The phone in someone's pocket keeps reading.
    lockVaultFor(MAC);
    expect(vaultStateFor(MAC)).toBe("locked");
    expect(vaultStateFor(PHONE)).toBe("unlocked");
    expect(vaultState()).toBe("unlocked"); // the key is still in memory for the phone

    lockVaultFor(PHONE);
    expect(vaultStateFor(PHONE)).toBe("locked");
    expect(authorizedDeviceCount()).toBe(0);
    // The last device out drops the key, so a vault nobody is holding open is
    // not left decryptable in memory.
    expect(vaultState()).toBe("locked");
    expect(() => mintLockedHeader()).toThrow(/vault is locked/);
  });

  test("locking a device that never unlocked leaves the others alone", async () => {
    await createVault("correct horse", MAC);
    lockVaultFor(PHONE); // a phone running ⌘L without ever having unlocked
    expect(vaultStateFor(MAC)).toBe("unlocked");
    expect(vaultState()).toBe("unlocked");
  });

  test("the idle clock is per device: touching one does not hold the other open", async () => {
    await createVault("correct horse", MAC);
    expect(await unlockVault("correct horse", PHONE)).toBe(true);
    const phoneAt = vaultActivityForTests(PHONE);
    await new Promise((done) => setTimeout(done, 5)); // the clock is in milliseconds
    touchVault(MAC);
    expect(vaultActivityForTests(MAC)).toBeGreaterThan(phoneAt);
    expect(vaultActivityForTests(PHONE)).toBe(phoneAt);
  });

  test("touching an unauthorized device does not let it in", async () => {
    await createVault("correct horse", MAC);
    touchVault(PHONE);
    expect(vaultStateFor(PHONE)).toBe("locked");
    expect(vaultActivityForTests(PHONE)).toBe(0);
  });

  test("tampered ciphertext refuses as damage, never wrong plaintext", async () => {
    await createVault("pw", MAC);
    const header = mintLockedHeader();
    const armored = sealBody(header, "the secret body\n");
    // Flip one character mid-ciphertext (past the nonce region).
    const i = Math.floor(armored.length / 2);
    const flipped = armored.slice(0, i) + (armored[i] === "A" ? "B" : "A") + armored.slice(i + 1);
    expect(() => openBody(header, flipped)).toThrow(/authentication|damaged/);
  });

  test("a locked note is self-contained: its header alone unlocks a vaultless machine", async () => {
    await createVault("travelling pw", MAC);
    const header = mintLockedHeader();
    const armored = sealBody(header, "synced body\n");
    // Simulate the other machine: no vault file, no memory.
    resetVaultForTests();
    await rm(VAULT_PATH, { force: true });
    await loadVault();
    expect(vaultState()).toBe("none");
    expect(await unlockVault("wrong", MAC, header)).toBe(false);
    expect(await unlockVault("travelling pw", MAC, header)).toBe(true);
    expect(openBody(header, armored)).toBe("synced body\n");
    // The probe unlock rebuilt the vault file from the header's salt, so the
    // next unlock is ordinary and needs no probe header.
    resetVaultForTests();
    await loadVault();
    expect(vaultState()).toBe("locked");
    expect(await unlockVault("travelling pw", MAC)).toBe(true);
  });

  test("a corrupt vault file is moved aside and costs nothing but the check", async () => {
    await createVault("pw", MAC);
    resetVaultForTests();
    await Bun.write(VAULT_PATH, "{not json");
    await loadVault();
    expect(vaultState()).toBe("none"); // moved aside, not fatal: a probe unlock rebuilds it
  });
});
