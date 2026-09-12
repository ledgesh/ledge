// `ledge-server pair` in a process of its own, describing keys with the real
// ssh-keygen. pair.test.ts covers the rules; this covers the flags reaching
// them, stdin as the key source a container uses, and the exit statuses.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { parsePairingLink } from "../shared/pairing";

const SERVE = join(import.meta.dir, "serve.ts");

// Throwaway public keys. The RSA one is a kind a phone cannot check.
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIYDISDKFG5VhQjSY/xJf2I0RpURJENyv/7EL0A/tOnZ root@atlas";
const ECDSA =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBKSEix15WYX2DKnD+62o2mmYSgT+e++cwNFgdL3kXdYBy9AA1PN2nj/b5XJstIL2otpRvrYYwzAHBSg0nciYBvM= root@atlas";
const RSA =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDJJPE5VRZ1YZQr0MahVR3N51QoozasuSO/G/+t1n1jCn0LWLbjIbrKctgepej1oRC3Dvlt+/S7izX9rK66sv0CnsuSTOfNVLOngnXoFCFs5tSJMhrWLbt70sqk2iOXiEswkTG/Nf9n0YfpAaXwTsE3dXAplLYltmhmfhBBXTsSOQ== root@old";

async function pair(args: string[], stdin = ""): Promise<{ status: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, SERVE, "pair", ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SSH_CONNECTION: "" },
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { status: await p.exited, stdout, stderr };
}

test("keys on stdin become a link a phone reads back with the same fields", async () => {
  const keys = [RSA, "not a key", ECDSA, ED25519].join("\n");
  const run = await pair(["--user", "dan", "--host", "atlas.example.net", "--port", "2222", "--keys", "-"], keys);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(parsePairingLink(run.stdout.trimEnd().split("\n").at(-1)!)).toEqual({
    code: {
      user: "dan",
      host: "atlas.example.net",
      port: 2222,
      fingerprints: ["SHA256:kBWN9w606aEkHeTSP5088vtsDyT5SyHSwfthuYAF2m8", "SHA256:f8HfqE098xVWKAXCt2/FkQ+4T7+uyK/D/A8HQFE9oNg"],
    },
  });
});

test("keys a phone cannot check are refused with the fix", async () => {
  const run = await pair(["--user", "dan", "--host", "atlas", "--keys", "-"], RSA);
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("sudo ssh-keygen -A");
});

test("stdin with no keys in it says so", async () => {
  const run = await pair(["--user", "dan", "--host", "atlas", "--keys", "-"], "nothing here\n");
  expect(run.status).toBe(1);
  expect(run.stderr).toBe("stdin holds no public host keys.\n");
});

test("a bad flag exits 2 with the usage, and --help prints it to stdout", async () => {
  const bad = await pair(["--hots", "atlas"]);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain("usage: ledge-server pair");
  const help = await pair(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toStartWith("usage: ledge-server pair");
});
