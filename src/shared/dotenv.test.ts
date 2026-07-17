import { describe, expect, test } from "bun:test";
import { parseDotenv, parseDotenvDoc, serializeDotenv } from "./dotenv";

describe("parseDotenv (the spawn parse)", () => {
  test("KEY=value lines, comments and blanks", () => {
    const { vars, problems } = parseDotenv("# creds\nA=1\n\nB=two words\n");
    expect(vars).toEqual({ A: "1", B: "two words" });
    expect(problems).toEqual([]);
  });

  test("an `export ` prefix is tolerated: files pasted from shell scripts work", () => {
    const { vars } = parseDotenv("export API_KEY=abc\n");
    expect(vars).toEqual({ API_KEY: "abc" });
  });

  test("values keep their inner = and lose only wrapping quotes", () => {
    const { vars } = parseDotenv('TOKEN=abc==\nURL="https://x.test/?a=1"\n');
    expect(vars).toEqual({ TOKEN: "abc==", URL: "https://x.test/?a=1" });
  });

  test("an empty value deliberately blanks the variable", () => {
    expect(parseDotenv("A=\n").vars).toEqual({ A: "" });
  });

  test("a bad line costs that line, never the rest of the file", () => {
    const { vars, problems } = parseDotenv("no equals here\n9BAD=x\nOK=1\n");
    expect(vars).toEqual({ OK: "1" });
    expect(problems.length).toBe(2);
  });

  test("CRLF files parse the same as LF ones", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n").vars).toEqual({ A: "1", B: "2" });
  });
});

describe("parseDotenvDoc (the editing parse)", () => {
  test("entries carry their line and their RAW value", () => {
    // Quotes stay: the user wrote them and will read them back in the editor.
    const rows = parseDotenvDoc('# header\nA=1\n\nURL="https://x/#y"\nexport B=2\n');
    expect(rows).toEqual([
      { line: 1, key: "A", value: "1", exported: false },
      { line: 3, key: "URL", value: '"https://x/#y"', exported: false },
      { line: 4, key: "B", value: "2", exported: true },
    ]);
  });

  test("comments and junk lines are not rows", () => {
    expect(parseDotenvDoc("# A=looks like one\njunk line\n9BAD=x\n")).toEqual([]);
  });
});

describe("serializeDotenv (the round trip)", () => {
  const FILE = "# Ledge profile\n\nA=1\nB=2\n";

  test("untouched rows keep the file byte-for-byte", () => {
    const rows = parseDotenvDoc(FILE).map((r) => ({ ...r }));
    expect(serializeDotenv(FILE, rows)).toBe(FILE);
  });

  test("an edited value rewrites its line; comments and blanks survive", () => {
    const rows = parseDotenvDoc(FILE).map((r) => (r.key === "B" ? { ...r, value: "22" } : r));
    expect(serializeDotenv(FILE, rows)).toBe("# Ledge profile\n\nA=1\nB=22\n");
  });

  test("a renamed key rewrites its line in place", () => {
    const rows = parseDotenvDoc(FILE).map((r) => (r.key === "A" ? { ...r, key: "ALPHA" } : r));
    expect(serializeDotenv(FILE, rows)).toBe("# Ledge profile\n\nALPHA=1\nB=2\n");
  });

  test("a deleted row deletes only its line", () => {
    const rows = parseDotenvDoc(FILE).filter((r) => r.key !== "A");
    expect(serializeDotenv(FILE, rows)).toBe("# Ledge profile\n\nB=2\n");
  });

  test("new rows append at the end, before the trailing newline", () => {
    const rows = [...parseDotenvDoc(FILE), { line: null, key: "C", value: "3" }];
    expect(serializeDotenv(FILE, rows)).toBe("# Ledge profile\n\nA=1\nB=2\nC=3\n");
  });

  test("an untouched export prefix survives; an edited one is preserved too", () => {
    const file = "export A=1\n";
    const rows = parseDotenvDoc(file);
    expect(serializeDotenv(file, rows)).toBe(file);
    expect(serializeDotenv(file, [{ ...rows[0]!, value: "9" }])).toBe("export A=9\n");
  });

  test("junk lines pass through even when everything around them changes", () => {
    const file = "A=1\nnot an entry\nB=2\n";
    const rows: Array<{ line: number | null; key: string; value: string; exported?: boolean }> = [
      ...parseDotenvDoc(file).filter((r) => r.key !== "A"),
      { line: null, key: "C", value: "3", exported: false },
    ];
    expect(serializeDotenv(file, rows)).toBe("not an entry\nB=2\nC=3\n");
  });

  test("an empty file grows entries and a trailing newline", () => {
    expect(serializeDotenv("", [{ line: null, key: "A", value: "1" }])).toBe("A=1\n");
    expect(serializeDotenv("", [])).toBe("");
  });
});
