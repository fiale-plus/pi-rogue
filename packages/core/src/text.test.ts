import { describe, it, expect } from "vitest";
import { truncate, safeName } from "./text.js";

describe("truncate", () => {
  it("returns full text when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates and appends ellipsis when over limit", () => {
    const result = truncate("hello world this is long", 12);
    expect(result).toHaveLength(12);
    expect(result.endsWith("…")).toBe(true);
  });

  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });
});

describe("safeName", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(safeName("My Feature Branch")).toBe("my-feature-branch");
  });

  it("replaces special characters with hyphens", () => {
    expect(safeName("feature/auth!!@#")).toBe("feature-auth");
  });

  it("strips leading/trailing hyphens", () => {
    expect(safeName("--main--")).toBe("main");
  });

  it("falls back to 'main' for empty input", () => {
    expect(safeName("")).toBe("main");
  });
});
