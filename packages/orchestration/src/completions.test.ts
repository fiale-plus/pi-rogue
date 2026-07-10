import { describe, expect, it } from "vitest";
import { autoresearchArgumentCompletions, goalArgumentCompletions, loopArgumentCompletions } from "./completions.js";

describe("goal completions", () => {
  it("offers goal management choices", () => {
    const values = goalArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["show", "status", "clear", "list", "set"]));
  });
});

describe("loop completions", () => {
  it("offers loop management and cadence choices", () => {
    const values = loopArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["status", "off", "1m", "5m", "1h"]));
  });
});

describe("autoresearch completions", () => {
  it("offers research management choices", () => {
    const values = autoresearchArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["status", "clear"]));
  });
});
