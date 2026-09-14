import { describe, expect, test } from "bun:test";
import { encode } from "uqr";
import { PORT_UNSET } from "../../shared/connections";
import { pairingLink, QR_OPTIONS } from "../../shared/pairing";
import { qrPath } from "./qr";

const LINK = pairingLink({
  user: "dan",
  host: "atlas.example.net",
  port: PORT_UNSET,
  fingerprints: ["SHA256:TC7eh5uTmsVcxQYnqmYU91fK88ypYrcXOZYJ2Je8i7w"],
});

describe("the code as a path", () => {
  test("one square per dark module, on the library's own grid", () => {
    const { data, size } = encode(LINK, QR_OPTIONS);
    const { size: drawn, d } = qrPath(LINK);
    expect(drawn).toBe(size);
    const squares = [...d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const dark = data.flatMap((row, y) => row.flatMap((on, x) => (on ? [[x, y]] : [])));
    expect(squares).toEqual(dark);
  });

  test("the quiet zone is four light modules on every side", () => {
    const { size, d } = qrPath(LINK);
    const xs = [...d.matchAll(/M(\d+) (\d+)h/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(Math.min(...xs.map(([x]) => x!))).toBe(4);
    expect(Math.min(...xs.map(([, y]) => y!))).toBe(4);
    expect(Math.max(...xs.map(([x]) => x!))).toBe(size - 5);
    expect(Math.max(...xs.map(([, y]) => y!))).toBe(size - 5);
  });
});
