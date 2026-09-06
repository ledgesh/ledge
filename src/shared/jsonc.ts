// `stripJsonc` turns JSONC into JSON: it removes `//` and `/* */` comments
// and trailing commas so the result feeds JSON.parse. settings.jsonc is
// hand-edited and its comments are its documentation, so the format has to
// tolerate them. A trailing comma is the most common hand-edit typo, and
// JSON.parse rejects one: the parse fails and Bun runs on defaults.
//
// Lives in shared/ because both ends parse the same text: Bun at launch
// (bun/settings.ts) and the settings editor dialog for its live validation
// (components/SettingsEditor.tsx). Bun and the dialog must read the file the
// same way, so there is exactly one stripper: do not write a second
// (architecture.md §6).
//
// The stripper writes spaces over comments instead of deleting them, and
// keeps the newlines. Offsets and line numbers in a JSON.parse error then
// still point at the user's own file. The scanner is lenient: it strips an
// unterminated string or comment to end-of-text and leaves JSON.parse to
// complain. stripJsonc never throws.

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

// Drops a comma exactly when the next meaningful character closes the
// container, `}` or `]`, and drops no other comma. Runs on comment-free
// text, so the lookahead only has whitespace to cross. A comma inside a
// string is string content like any other.
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

// Returns the index just past the closing quote of the string starting at
// `start`. The caller must pass a `start` that indexes a `"`. The scan
// honors backslash escapes, and returns end-of-text for an unclosed string.
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
