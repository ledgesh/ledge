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
  resetVaultForTests,
  sealBody,
  splitHead,
  stampLockedLine,
  stripLockedLine,
  unlockVault,
  VAULT_PATH,
  vaultState,
} from "./vault";

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
    await createVault("correct horse");
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

    expect(await unlockVault("wrong pass")).toBe(false);
    expect(vaultState()).toBe("locked");
    expect(await unlockVault("correct horse")).toBe(true);
    expect(openBody(header, armored)).toBe(body);
  });

  test("unlocking an already-unlocked vault still checks the passphrase", async () => {
    // The answer used to be an unconditional yes whenever the key was in
    // memory. No screen reached it, since the dialog opens only while the
    // vault is shut, but the RPC is the contract and scoping an unlock to a
    // caller would have turned the same shape into a way in (locking.md §3).
    await createVault("correct horse");
    expect(vaultState()).toBe("unlocked");

    expect(await unlockVault("wrong pass")).toBe(false);
    // And a wrong answer changes nothing: relocking on a typo would be a way
    // to shut somebody else's session out.
    expect(vaultState()).toBe("unlocked");

    expect(await unlockVault("correct horse")).toBe(true);
    expect(vaultState()).toBe("unlocked");
  });

  test("tampered ciphertext refuses as damage, never wrong plaintext", async () => {
    await createVault("pw");
    const header = mintLockedHeader();
    const armored = sealBody(header, "the secret body\n");
    // Flip one character mid-ciphertext (past the nonce region).
    const i = Math.floor(armored.length / 2);
    const flipped = armored.slice(0, i) + (armored[i] === "A" ? "B" : "A") + armored.slice(i + 1);
    expect(() => openBody(header, flipped)).toThrow(/authentication|damaged/);
  });

  test("a locked note is self-contained: its header alone unlocks a vaultless machine", async () => {
    await createVault("travelling pw");
    const header = mintLockedHeader();
    const armored = sealBody(header, "synced body\n");
    // Simulate the other machine: no vault file, no memory.
    resetVaultForTests();
    await rm(VAULT_PATH, { force: true });
    await loadVault();
    expect(vaultState()).toBe("none");
    expect(await unlockVault("wrong", header)).toBe(false);
    expect(await unlockVault("travelling pw", header)).toBe(true);
    expect(openBody(header, armored)).toBe("synced body\n");
    // The probe unlock rebuilt the vault file from the header's salt, so the
    // next unlock is ordinary and needs no probe header.
    resetVaultForTests();
    await loadVault();
    expect(vaultState()).toBe("locked");
    expect(await unlockVault("travelling pw")).toBe(true);
  });

  test("a corrupt vault file is moved aside and costs nothing but the check", async () => {
    await createVault("pw");
    resetVaultForTests();
    await Bun.write(VAULT_PATH, "{not json");
    await loadVault();
    expect(vaultState()).toBe("none"); // moved aside, not fatal: a probe unlock rebuilds it
  });
});
