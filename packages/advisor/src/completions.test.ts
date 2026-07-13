import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADVISOR_CANONICAL_CONTROL_LEAVES, advisorArgumentCompletions, piRogueArgumentCompletions } from "./completions.js";

describe("advisor completions", () => {
  it("offers top-level advisor continuations", () => {
    const values = advisorArgumentCompletions("")?.map((i) => i.value);
    expect(values).toEqual([...ADVISOR_CANONICAL_CONTROL_LEAVES]);
  });

  it("keeps canonical README, skill, UX, and AGENTS guidance aligned", () => {
    const root = process.cwd();
    const readme = readFileSync(join(root, "packages/advisor/README.md"), "utf8");
    const skill = readFileSync(join(root, "packages/advisor/skills/advisor/SKILL.md"), "utf8");
    const ux = readFileSync(join(root, "docs/pi-rogue-config-ux.md"), "utf8");
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    for (const leaf of ADVISOR_CANONICAL_CONTROL_LEAVES) {
      expect(readme, `README: ${leaf}`).toContain(`/pi-rogue-advisor ${leaf}`);
      expect(skill, `skill: ${leaf}`).toContain(`/pi-rogue-advisor ${leaf}`);
      expect(ux, `UX matrix: ${leaf}`).toContain(`\`${leaf}\``);
    }
    expect(agents).toContain("/pi-rogue-advisor");
    expect(agents).not.toMatch(/`\/advisor(?:\s|`)/);
  });

  it("offers nested review choices", () => {
    const values = advisorArgumentCompletions("review ")?.map((i) => i.value);
    expect(values).toEqual(["light", "strict", "off"]);
  });

  it("offers explicit advisor profile controls", () => {
    expect(advisorArgumentCompletions("profile ")?.map((i) => i.value)).toEqual(["status", "budget-board", "off"]);
  });

  it("offers board shadow, head-of-board, and specialist controls", () => {
    expect(advisorArgumentCompletions("")?.map((i) => i.value)).toContain("board");
    expect(advisorArgumentCompletions("board ")?.map((i) => i.value)).toEqual(["status", "why", "report", "shadow", "off", "reset", "head", "specialist", "discover-specialists"]);
  });

  it("offers personal specialist discovery controls", () => {
    expect(advisorArgumentCompletions("board ")?.map((i) => i.value)).toContain("discover-specialists");
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
