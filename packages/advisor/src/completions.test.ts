import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADVISOR_CANONICAL_CONTROL_LEAVES, advisorArgumentCompletions, piRogueArgumentCompletions } from "./completions.js";

describe("advisor completions", () => {
  it("offers top-level advisor continuations", () => {
    const values = advisorArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(["status", "settings", "model", "board"]);
  });

  it("keeps the canonical README and agent guidance aligned", () => {
    const root = process.cwd();
    const readme = readFileSync(join(root, "packages/advisor/README.md"), "utf8");
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    for (const leaf of ADVISOR_CANONICAL_CONTROL_LEAVES) {
      expect(readme, `README: ${leaf}`).toContain(`/pi-rogue-advisor ${leaf}`);
    }
    expect(readme).toContain("/pi-rogue-advisor board specialist ask");
    expect(readme).toContain("/pi-rogue-advisor board head ask");
    expect(agents).toContain("/pi-rogue-advisor");
    expect(agents).not.toMatch(/`\/advisor(?:\s|`)/);
  });

  it("offers explicit model syntax", () => {
    expect(advisorArgumentCompletions("model ")?.map((i) => i.value)).toEqual(["list", "advisor", "specialist", "head", "null"]);
    expect(advisorArgumentCompletions("model list ")?.map((i) => i.value)).toEqual(["advisor", "specialist", "head"]);
  });

  it("offers explicit Board roles without shadow or discovery controls", () => {
    expect(advisorArgumentCompletions("board ")?.map((i) => i.value)).toEqual(["specialist", "head"]);
    expect(advisorArgumentCompletions("review ")).toBeNull();
    expect(advisorArgumentCompletions("profile ")).toBeNull();
  });

});

describe("pi-rogue cockpit completions", () => {
  it("offers only concise root management commands", () => {
    const values = piRogueArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual(["status", "help", "doctor"]);
  });

  it("does not fan out subsystem or deprecated configure choices", () => {
    expect(piRogueArgumentCompletions("configure ")).toBeNull();
  });
});
