import { describe, expect, it } from "vitest";
import { classifyIntent, classifyMode } from "./preflight-signals.js";

describe("preflight signal classifiers", () => {
  it("classifies planning prompts", () => {
    expect(classifyIntent("what should we do next, design the architecture")).toBe("plan");
  });

  it("classifies implementation prompts", () => {
    expect(classifyIntent("implement the auth flow and add tests")).toBe("implement");
  });

  it("classifies review prompts", () => {
    expect(classifyIntent("please review this PR and check the diff")).toBe("review");
  });

  it("classifies questions vs commands", () => {
    expect(classifyMode("what should we do next?")).toBe("question");
    expect(classifyMode("run the tests and fix the bug")).toBe("command");
    expect(classifyMode("hello there")).toBe("neutral");
  });
});
