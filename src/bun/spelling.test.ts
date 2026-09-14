// The dictionary seam's pure halves: which words may reach osascript, and how
// its output is read. The script itself runs only against a real Mac
// (testing.md §6), since a lookup reads the developer's own dictionary.
import { describe, expect, test } from "bun:test";
import { isSpellableWord, parseCheck } from "./spelling";

describe("the words a lookup accepts", () => {
  test("letters, with apostrophes and hyphens inside", () => {
    for (const w of ["recieve", "don't", "don’t", "e-mail", "Straße", "écrit"]) expect(isSpellableWord(w)).toBe(true);
  });

  test("anything else is refused before a process starts", () => {
    for (const w of ["", "'quoted", "trailing-", "two words", "x2", "a;b", "-e", "x".repeat(65)]) {
      expect(isSpellableWord(w)).toBe(false);
    }
  });
});

describe("reading the script's answer", () => {
  test("a misspelling carries at most five guesses", () => {
    const out = JSON.stringify({ misspelled: true, guesses: ["a", "b", "c", "d", "e", "f"] });
    expect(parseCheck(out)).toEqual({ misspelled: true, guesses: ["a", "b", "c", "d", "e"] });
  });

  test("a misspelling with no guesses is still a misspelling", () => {
    expect(parseCheck('{"misspelled":true,"guesses":null}')).toEqual({ misspelled: true, guesses: [] });
  });

  test("output it cannot read, or no output, counts as a correct word", () => {
    for (const out of [null, "", "not json", '{"misspelled":"yes"}']) {
      expect(parseCheck(out)).toEqual({ misspelled: false, guesses: [] });
    }
  });

  test("a guess that is not a string is dropped", () => {
    expect(parseCheck('{"misspelled":true,"guesses":["receive",3,null]}')).toEqual({
      misspelled: true,
      guesses: ["receive"],
    });
  });
});
