// JSONC → JSON: strip `//` and `/* */` comments and trailing commas so the
// result feeds JSON.parse. Settings.jsonc is hand-edited with the comments AS
// the documentation, so the file format has to tolerate them — and trailing
// commas ride along because they are the single most common hand-edit typo,
// and "the whole file falls back to defaults" is a steep price for one comma.
//
// Lives in shared/ because both ends parse the same text: Bun at launch
// (bun/settings.ts) and the settings editor dialog for its live validation
// (components/SettingsEditor.tsx). The two must agree on what the file means,
// so there is exactly one stripper.
//
// Comments are replaced by spaces (newlines kept), not deleted: offsets and
// line numbers in any JSON.parse error still point at the user's actual file.
// The scanner is deliberately lenient — an unterminated string or comment
// strips to end-of-text and lets JSON.parse be the one to complain; this
// function never throws.

export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Runs on comment-free text, so the lookahead only has whitespace to cross.
// The comma is dropped exactly when the next meaningful character closes the
// container; a comma inside a string is string content like any other.
function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") i++; // drop the comma
      else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Index just past the closing quote of the string starting at `start`
// (text[start] is `"`), honoring backslash escapes; end-of-text if unclosed.
function endOfString(text: string, start: number): number {
  let i = start + 1;
  const n = text.length;
  while (i < n) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return n;
}
