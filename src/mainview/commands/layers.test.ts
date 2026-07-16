import { describe, expect, test } from "bun:test";
import { createLayerStack } from "./layers";

describe("createLayerStack", () => {
  test("LIFO: the last push is the top", () => {
    const s = createLayerStack<string>();
    s.push("menu");
    s.push("dialog");
    expect(s.top()).toBe("dialog");
  });

  test("dispose pops its own layer, wherever it sits", () => {
    const s = createLayerStack<string>();
    const dropMenu = s.push("menu");
    s.push("dialog");
    // The menu closes (outside click) while the dialog is still up.
    dropMenu();
    expect(s.top()).toBe("dialog");
    expect(s.size()).toBe(1);
  });

  test("top layer dispose reveals the one beneath", () => {
    const s = createLayerStack<string>();
    s.push("overlay");
    const dropDialog = s.push("dialog");
    dropDialog();
    expect(s.top()).toBe("overlay");
  });

  test("dispose is idempotent and never pops a sibling", () => {
    const s = createLayerStack<string>();
    const dropA = s.push("a");
    s.push("b");
    dropA();
    dropA(); // second call must not touch "b"
    expect(s.size()).toBe(1);
    expect(s.top()).toBe("b");
  });

  test("duplicate values are distinct layers", () => {
    const s = createLayerStack<string>();
    s.push("menu");
    const dropSecond = s.push("menu");
    dropSecond();
    expect(s.size()).toBe(1);
  });

  test("empty stack has no top", () => {
    const s = createLayerStack<string>();
    expect(s.top()).toBeNull();
    expect(s.size()).toBe(0);
  });
});
