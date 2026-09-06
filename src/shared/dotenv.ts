// Dotenv files (profiles, envFiles): KEY=value per line, with # comments,
// blank lines, and an optional `export ` prefix. A file pasted out of a
// shell script works as it stands.
//
// The module is in `src/shared/` because both ends read the format: Bun
// merges these files into a shell's spawn env (bun/spawnParams.ts), and the
// view's profile editor (components/ProfileEditor.tsx) shows them as
// key/value rows. So the module parses the text two ways:
//
// - `parseDotenv` is the spawn parse: names validated, quotes stripped, bad
//   lines reported.
// - `parseDotenvDoc` and `serializeDotenv` are the editing pair: values stay
//   raw (quotes and all, since the user wrote them and will read them back),
//   and comments, blanks and junk lines survive an edit verbatim.
import { isEnvName, unquote } from "./frontmatter";

/** Spawn parse: the vars a shell should receive (see header). */
export function parseDotenv(text: string): { vars: Record<string, string>; problems: string[] } {
  const vars: Record<string, string> = {};
  const problems: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) {
      problems.push(`not a "KEY=value" line: "${line}"`);
      continue;
    }
    const key = stripped.slice(0, eq).trim();
    if (!isEnvName(key)) {
      problems.push(`"${key}" is not a usable variable name`);
      continue;
    }
    // The value may be empty ("KEY=" blanks a variable) and may contain
    // further "=" (base64, URLs with query strings).
    vars[key] = unquote(stripped.slice(eq + 1).trim());
  }
  return { vars, problems };
}

/** One entry line as the editor sees it: the raw value and its line number. */
export interface DotenvRow {
  // Index into the text's lines; the join key for serializeDotenv.
  line: number;
  key: string;
  // Raw text after the "=", trimmed but not unquoted: what the user wrote.
  value: string;
  exported: boolean;
}

const ENTRY = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** Editing parse: the entry rows, leaving every other line alone. */
export function parseDotenvDoc(text: string): DotenvRow[] {
  const rows: DotenvRow[] = [];
  text.split("\n").forEach((rawLine, line) => {
    const raw = rawLine.replace(/\r$/, "");
    if (raw.trim().startsWith("#")) return;
    const m = ENTRY.exec(raw);
    if (m) rows.push({ line, key: m[2]!, value: m[3]!, exported: !!m[1] });
  });
  return rows;
}

/**
 * Write edited rows back into `text`. A row with a `line` replaces that line
 * (verbatim when nothing about it changed, so untouched lines keep their
 * exact bytes). An entry line with no surviving row is deleted. A row with
 * `line: null` is appended at the end. Comments, blanks, and junk lines pass
 * through untouched; the header says why that is the contract.
 */
export function serializeDotenv(
  text: string,
  rows: ReadonlyArray<{ line: number | null; key: string; value: string; exported?: boolean }>,
): string {
  const lines = text.split("\n");
  const orig = new Map(parseDotenvDoc(text).map((r) => [r.line, r]));
  const edited = new Map(rows.filter((r) => r.line !== null).map((r) => [r.line as number, r]));

  const out: string[] = [];
  lines.forEach((raw, i) => {
    const o = orig.get(i);
    if (!o) {
      out.push(raw); // not an entry: comments, blanks, junk stay verbatim
      return;
    }
    const r = edited.get(i);
    if (!r) return; // deleted in the editor
    const exported = r.exported ?? o.exported;
    const same = r.key === o.key && r.value === o.value && exported === o.exported;
    out.push(same ? raw : entryLine(r.key, r.value, exported));
  });

  // Appends go before the trailing empty element (a file ending in \n splits
  // into one), so the file keeps ending with a newline instead of growing
  // text after it.
  const tail = out.length > 0 && out[out.length - 1] === "" ? out.pop() : undefined;
  for (const r of rows) {
    if (r.line === null) out.push(entryLine(r.key, r.value, r.exported ?? false));
  }
  out.push(tail ?? "");
  return out.join("\n");
}

function entryLine(key: string, value: string, exported: boolean): string {
  return `${exported ? "export " : ""}${key}=${value}`;
}
