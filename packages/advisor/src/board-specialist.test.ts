import { describe, expect, it } from "vitest";
import { buildBoardLedger, type BoardEvent } from "./board.js";
import { loadBoardRoleBody, loadBoardRoleCatalog, type BoardRoleBody } from "./board-roles.js";
import {
  buildSpecialistDispatchRequest,
  callReadOnlySpecialist,
  defaultSpecialistCallState,
  defaultSpecialistDispatchConfig,
  evaluateSpecialistPolicy,
  parseSpecialistResponse,
  suggestSpecialistRoles,
} from "./board-specialist.js";

function ledger(events: BoardEvent[] = []) {
  return buildBoardLedger([
    { type: "session", id: "s1", repo: "fiale-plus/pi-rogue" },
    ...events,
  ]);
}

function role(id = "reviewer"): BoardRoleBody {
  const catalog = loadBoardRoleCatalog();
  const summary = catalog.roles.find((item) => item.id === id)!;
  return loadBoardRoleBody(summary).role!;
}

describe("board specialist dispatch", () => {
  it("suggests an enabled read-only specialist from compact board signals", () => {
    const catalog = loadBoardRoleCatalog();
    const suggestions = suggestSpecialistRoles(catalog.roles, ledger([
      { type: "file_changed", path: "packages/advisor/src/extension.ts", turn: 3 },
      { type: "validation", command: "npm test", exitCode: 1, status: "red", turn: 4 },
    ]));

    expect(suggestions.map((item) => item.id)).toContain("reviewer");
  });

  it("calls a read-only specialist with compact ledger and strict JSON response", async () => {
    const testRole = role();
    const result = await callReadOnlySpecialist({
      role: testRole,
      ledger: ledger([{ type: "validation", command: "npm test", exitCode: 1, status: "red", turn: 4 }]),
      task: "Review missing test coverage",
      config: defaultSpecialistDispatchConfig(),
      state: defaultSpecialistCallState(),
      currentTurn: 5,
      complete: async (systemPrompt, messages, options) => {
        expect(systemPrompt).toContain("read-only specialist");
        expect(systemPrompt).toContain("Do not request or perform edits");
        expect(messages[0]?.content).toContain("board_ledger");
        expect(options.maxTokens).toBeLessThanOrEqual(testRole.maxTokens);
        return JSON.stringify({ verdict: "important", confidence: 0.82, findings: [{ path: "packages/advisor/src/extension.ts", evidence: "validation failed", risk: "missing regression" }], recommendation: "Add a focused regression test." });
      },
    });

    expect("denied" in result).toBe(false);
    expect("error" in result).toBe(false);
    if ("denied" in result || "error" in result) return;
    expect(result.response.verdict).toBe("important");
    expect(result.note).toContain("reviewer: important");
    expect(result.state.calls).toBe(1);
    expect(JSON.stringify(result.request)).not.toContain("raw specialist transcript");
  });

  it("fails closed for policy denial, cooldown, budget, and tool escalation", () => {
    const testRole = role();
    const cfg = defaultSpecialistDispatchConfig();

    expect(evaluateSpecialistPolicy({ role: testRole, caller: "codriver", config: { ...cfg, mode: "off" }, state: defaultSpecialistCallState(), currentTurn: 10, task: "x" }).reason).toBe("disabled");
    expect(evaluateSpecialistPolicy({ role: { ...testRole, enabledByDefault: false }, caller: "codriver", config: cfg, state: defaultSpecialistCallState(), currentTurn: 10, task: "x" }).reason).toBe("disabled");
    expect(evaluateSpecialistPolicy({ role: testRole, caller: "user", config: cfg, state: defaultSpecialistCallState(), currentTurn: 10, task: "x" }).reason).toBe("not_callable");
    expect(evaluateSpecialistPolicy({ role: { ...testRole, allowedTools: ["read", "bash" as any] }, caller: "codriver", config: cfg, state: defaultSpecialistCallState(), currentTurn: 10, task: "x" }).reason).toBe("tool_escalation");
    expect(evaluateSpecialistPolicy({ role: testRole, caller: "codriver", config: cfg, state: { calls: 3, byRole: {} }, currentTurn: 10, task: "x" }).reason).toBe("budget");
    expect(evaluateSpecialistPolicy({ role: testRole, caller: "codriver", config: cfg, state: { calls: 1, byRole: { reviewer: { calls: 1, lastTurn: 8 } } }, currentTurn: 10, task: "x" }).reason).toBe("cooldown");
  });

  it("counts invalid specialist responses against budget and cooldown", async () => {
    const result = await callReadOnlySpecialist({
      role: role(),
      ledger: ledger([{ type: "validation", command: "npm test", exitCode: 1, status: "red", turn: 4 }]),
      task: "Review tests",
      config: defaultSpecialistDispatchConfig(),
      state: defaultSpecialistCallState(),
      currentTurn: 7,
      complete: async () => JSON.stringify({ verdict: "bad", confidence: 2, findings: [], recommendation: "" }),
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.state.calls).toBe(1);
    expect(result.state.byRole.reviewer?.lastTurn).toBe(7);
  });

  it("redacts and bounds compact specialist input", () => {
    const request = buildSpecialistDispatchRequest(role(), ledger([
      { type: "tool_failure", tool: "bash", key: "npm-test", message: "failed with Authorization: Bearer abcdef1234567890 and AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP", turn: 4 },
    ]), "Review MY_SECRET=shhhhhhh");
    const payload = JSON.stringify(request);

    expect(payload).not.toContain("abcdef1234567890");
    expect(payload).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(payload).not.toContain("AWS_ACCESS_KEY_ID=AKIA");
    expect(payload).not.toContain("shhhhhhh");
    expect(payload).toContain("[secret]");
  });

  it("rejects invalid specialist responses", () => {
    expect(() => parseSpecialistResponse(JSON.stringify({ verdict: "ship", confidence: 2, findings: [], recommendation: "ok" }))).toThrow("invalid specialist verdict");
    expect(() => parseSpecialistResponse(JSON.stringify({ verdict: "note", confidence: 0.5, findings: [], recommendation: "" }))).toThrow("invalid specialist recommendation");
  });
});
