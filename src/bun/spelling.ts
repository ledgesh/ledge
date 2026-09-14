// The Mac's spelling dictionary, for the editor's right-click menu
// (interactions.md §12).
//
// WebKit draws the squiggles from NSSpellChecker and gives the page no way to
// ask which word it flagged or what it would suggest. So the menu asks the
// same checker directly, through osascript's JavaScript bridge to AppKit: the
// route bun/clipboard.ts takes for the pasteboard flavors Bun has no binding
// for. A warm run takes about 70ms. The word arrives as an argument, never as
// script text.

// Letters, with apostrophes and hyphens inside a word ("don't", "e-mail").
// The view sends only words of this shape (editor/spelling.ts wordAround),
// and this is the boundary, so the check repeats here.
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

// Enough of a paragraph to name its language.
const MAX_CONTEXT = 2000;

/** Whether `word` is misspelled in the language of `context`, the paragraph
 * around it, and what the checker would put in its place. */
export async function checkWord(word: string, context: string): Promise<{ misspelled: boolean; guesses: string[] }> {
  if (!isSpellableWord(word)) return { misspelled: false, guesses: [] };
  return parseCheck(await jxa(CHECK_SCRIPT, word, context.slice(0, MAX_CONTEXT) || word));
}

/** Adds `word` to the Mac's own dictionary, which every app on it shares. */
export async function learnWord(word: string): Promise<boolean> {
  if (!isSpellableWord(word)) return false;
  return (await jxa(LEARN_SCRIPT, word)) === "ok";
}
