import { afterEach, describe, expect, test } from "bun:test";
import { resetSort, seedSort, setSort, sortIn, subscribeSort } from "./sorting";

afterEach(resetSort);

describe("note sort", () => {
  test("a workspace never switched sorts by title", () => {
    expect(sortIn("/r")).toBe("title");
  });

  test("each workspace keeps its own order", () => {
    setSort("/r", "modified");
    expect(sortIn("/r")).toBe("modified");
    expect(sortIn("/r2")).toBe("title");
  });

  test("a switch to the order already in place tells no listener", () => {
    const heard: string[] = [];
    const off = subscribeSort(() => heard.push(sortIn("/r")));
    setSort("/r", "title");
    setSort("/r", "modified");
    setSort("/r", "modified");
    off();
    expect(heard).toEqual(["modified"]);
  });

  test("a seed of anything but a known order is the default", () => {
    setSort("/r", "modified");
    seedSort("/r", "size");
    expect(sortIn("/r")).toBe("title");
    seedSort("/r", "modified");
    expect(sortIn("/r")).toBe("modified");
  });
});
