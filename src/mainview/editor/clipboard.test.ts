// eventPaste, the rule for what the editor does with a paste event
// (editor/clipboard.ts). A real event reaching CodeMirror is the e2e half
// (images.spec.ts, paste-html.spec.ts).
import { describe, expect, test } from "bun:test";
import { eventPaste } from "./clipboard";

describe("eventPaste", () => {
  test("text wins over a picture, as it does for ⌘V", () => {
    expect(eventPaste("caption", "<b>caption</b>", ["image/png"])).toEqual({
      kind: "text",
      text: "caption",
      html: "<b>caption</b>",
    });
  });

  test("a picture and no text is an image paste", () => {
    expect(eventPaste("", "", ["image/jpeg"])).toEqual({ kind: "image" });
  });

  test("a file that is not a picture is nothing the editor pastes", () => {
    expect(eventPaste("", "", ["application/pdf"])).toBeNull();
  });

  test("an empty event, which is all a Mac's ever carries, is left to CodeMirror", () => {
    expect(eventPaste("", "", [])).toBeNull();
  });
});
