import { describe, expect, it } from "vitest";
import { advisorArgumentCompletions, piRogueArgumentCompletions } from "./completions.js";

describe("advisor completions", () => {
  it("offers top-level advisor continuations", () => {
    const values = advisorArgumentCompletions("")?.map((i) => i.value);
    expect(values).not.toEqual(expect.arrayContaining(["pause", "unpause"]));
    expect(values).not.toContain("config");
  });

  it("offers nested review choices", () => {
    const values = advisorArgumentCompletions("review ")?.map((i) => i.value);
    expect(values).toEqual(["light", "strict", "off"]);
  });

  it("offers board shadow, head-of-board, and specialist controls", () => {
    expect(advisorArgumentCompletions("")?.map((i) => i.value)).toContain("board");
    expect(advisorArgumentCompletions("board ")?.map((i) => i.value)).toEqual(["status", "shadow", "off", "reset", "head", "specialist"]);
  });

});

describe("pi-rogue cockpit completions", () => {
  it("offers only concise root management commands", () => {
    const values = piRogueArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(["status", "help", "doctor"]);
    expect(values).not.toEqual(expect.arrayContaining(["config", "advisor", "router", "fusion", "orchestration"]));
  });

  it("does not fan out subsystem or deprecated configure choices", () => {
    expect(piRogueArgumentCompletions("configure ")).toBeNull();
    expect(piRogueArgumentCompletions("router ")).toBeNull();
  });
});
