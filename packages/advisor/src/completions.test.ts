import { describe, expect, it } from "vitest";
import { advisorArgumentCompletions, piRogueArgumentCompletions } from "./completions.js";

describe("advisor completions", () => {
  it("offers top-level advisor continuations", () => {
    const values = advisorArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["status", "config", "model", "review", "pause", "unpause"]));
    expect(values).not.toContain("checkins");
  });

  it("offers nested review choices", () => {
    const values = advisorArgumentCompletions("review ")?.map((i) => i.value);
    expect(values).toEqual(["light", "strict", "off"]);
  });

});

describe("pi-rogue cockpit completions", () => {
  it("offers umbrella sections", () => {
    const values = piRogueArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["status", "advisor", "orchestration", "help"]));
  });

  it("fans out to orchestration shortcuts", () => {
    const values = piRogueArgumentCompletions("orchestration ")?.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["goal", "loop", "autoresearch", "autoresearch-lab"]));
  });
});
