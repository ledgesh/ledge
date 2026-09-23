// This machine's spelling dictionary, for the editor's right-click menu
// (interactions.md §12).
//
// WebKit draws the squiggles and gives the page no way to ask which word it
// flagged or what it would suggest. So the menu asks the same checker
// directly. On a Mac that is NSSpellChecker, through osascript's JavaScript
// bridge to AppKit: the route bun/clipboard.ts takes for the pasteboard
// flavors Bun has no binding for. On Linux it is Enchant, the library
// WebKitGTK's squiggles come from, through `enchant-2 -a`, its ispell-style
// pipe mode. A warm run of either takes well under 100ms. The word arrives as
// an argument or on the pipe, never as script text.

// Letters, with apostrophes and hyphens inside a word ("don't", "e-mail").
// The view sends only words of this shape (editor/spelling.ts wordAround),
// and this is the boundary, so the check repeats here. It is also what keeps
// a word from carrying a newline into Enchant's line protocol.
const WORD = /^\p{L}+(?:['’-]\p{L}+)*$/u;
const MAX_WORD = 64;

export function isSpellableWord(word: string): boolean {
  return word.length <= MAX_WORD && WORD.test(word);
}

// The checker's automatic mode accepts a word that is correct in any language
// the Mac has enabled, which passes "paragraf" and "dont". WebKit judges a
// word in its paragraph's language, so the script asks the paragraph
// (`context`) for its dominant language first and checks the word alone in
// that. NSSpellChecker answers location NSNotFound for a correct word, which
// JXA reads as a huge number, hence the length test.
const CHECK_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  const word = argv[0];
  const tagged = $.NSLinguisticTagger.dominantLanguageForString($(argv[1]));
  const lang = tagged.isNil() || tagged.js === "und" ? $() : tagged;
  const checker = $.NSSpellChecker.sharedSpellChecker;
  const miss = checker.checkSpellingOfStringStartingAtLanguageWrapInSpellDocumentWithTagWordCount(
    $(word), 0, lang, false, 0, null);
  if (miss.location > word.length) return JSON.stringify({ misspelled: false, guesses: [] });
  const guesses = checker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag(
    $.NSMakeRange(0, word.length), $(word), lang, 0);
  return JSON.stringify({ misspelled: true, guesses: ObjC.deepUnwrap(guesses) || [] });
}`;

const LEARN_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  $.NSSpellChecker.sharedSpellChecker.learnWord($(argv[0]));
  return "ok";
}`;

async function jxa(script: string, ...args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script, ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/** The guesses the menu offers, parsed from the script's output. Anything it
 * cannot read counts as a correct word, so a failed lookup offers nothing
 * rather than a wrong fix. */
export function parseCheck(out: string | null): { misspelled: boolean; guesses: string[] } {
  try {
    const v = JSON.parse(out ?? "") as { misspelled?: unknown; guesses?: unknown };
    if (v.misspelled !== true) return { misspelled: false, guesses: [] };
    const guesses = Array.isArray(v.guesses) ? v.guesses.filter((g): g is string => typeof g === "string") : [];
    return { misspelled: true, guesses: guesses.slice(0, 5) };
  } catch {
    return { misspelled: false, guesses: [] };
  }
}

// Enchant's command-line client. PATH-resolved: distributions put it in
// /usr/bin, and a desktop that installed it elsewhere put that on PATH too.
const ENCHANT = "enchant-2";

/**
 * Whether this machine has a dictionary to ask at all. A Mac always does. A
 * Linux desktop has one when `enchant-2` is installed, which Ubuntu does
 * beside WebKitGTK; without it the shell offers no spelling (bun/index.ts),
 * and every word answers correct.
 */
export function hasDictionary(): boolean {
  return process.platform === "darwin" || Bun.which(ENCHANT) !== null;
}

// Enchant's answer for `^word` on the pipe, one line after its version
// banner: `*`, `+` or `-` for a word it accepts, `# word offset` for a
// misspelling with no guesses, and `& word count offset: a, b, c` for one
// with guesses. The caret ahead of the word keeps a word that starts with one
// of those characters from reading as a command.
const ENCHANT_LINE = /^[*+#&-]/;

/** Enchant's pipe-mode answer, parsed the way `parseCheck` parses the Mac's:
 * anything unreadable is a correct word. */
export function parseEnchant(out: string | null): { misspelled: boolean; guesses: string[] } {
  const line = (out ?? "").split("\n").find((l) => ENCHANT_LINE.test(l)) ?? "";
  const mark = line[0];
  if (mark === "#") return { misspelled: true, guesses: [] };
  if (mark !== "&") return { misspelled: false, guesses: [] };
  const colon = line.indexOf(":");
  const guesses = colon < 0 ? [] : line.slice(colon + 1).split(",").map((g) => g.trim()).filter((g) => g !== "");
  return { misspelled: true, guesses: guesses.slice(0, 5) };
}

// One pipe-mode session: `input` in, everything Enchant printed out, or null
// when it could not run or exited non-zero.
async function enchant(input: string): Promise<string | null> {
  try {
    const p = Bun.spawn([ENCHANT, "-a"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(input);
    await p.stdin.end();
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

// Enough of a paragraph to name its language.
const MAX_CONTEXT = 2000;

/** Whether `word` is misspelled in the language of `context`, the paragraph
 * around it, and what the checker would put in its place. Enchant is asked in
 * the session's own language: it has no tagger, and the same dictionary drew
 * the squiggle that opened the menu. */
export async function checkWord(word: string, context: string): Promise<{ misspelled: boolean; guesses: string[] }> {
  if (!isSpellableWord(word)) return { misspelled: false, guesses: [] };
  if (process.platform !== "darwin") return parseEnchant(await enchant(`^${word}\n`));
  return parseCheck(await jxa(CHECK_SCRIPT, word, context.slice(0, MAX_CONTEXT) || word));
}

/** Adds `word` to this machine's own dictionary, which every app on it
 * shares: the Mac's, or Enchant's personal word list under ~/.config/enchant,
 * which `*word` adds to and `#` saves. */
export async function learnWord(word: string): Promise<boolean> {
  if (!isSpellableWord(word)) return false;
  if (process.platform !== "darwin") return (await enchant(`*${word}\n#\n`)) !== null;
  return (await jxa(LEARN_SCRIPT, word)) === "ok";
}
