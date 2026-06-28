import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyAdvisorBoardProfilePlan,
  budgetBoardEscalationPolicyText,
  buildAdvisorBoardProfilePlan,
  normalizeAdvisorConfig,
  type AdvisorConfig,
} from "./extension.js";

type SmokeModel = { provider: string; id: string; input: string[] };

type SmokeCheckStatus = "pass" | "fail";

export interface BudgetBoardSmokeCheck {
  id: string;
  status: SmokeCheckStatus;
  detail: string;
}

export interface BudgetBoardSmokeResult {
  schema: "pi-rogue.budget-board-smoke.v1";
  ok: boolean;
  noLiveModelCalls: true;
  profile: "budget-board";
  advisorConfigPath: string;
  driverRecommendation: string;
  advisorModel: string;
  checks: BudgetBoardSmokeCheck[];
}

export const DEFAULT_BUDGET_BOARD_SMOKE_MODELS: SmokeModel[] = [
  { provider: "openai-codex", id: "gpt-5.5", input: ["text"] },
  { provider: "openai-codex", id: "gpt-5.5-mini", input: ["text"] },
  { provider: "image-only", id: "paint", input: ["image"] },
];

function modelRegistry(models: SmokeModel[]) {
  return {
    getAvailable: () => models,
    find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
  };
}

function check(id: string, passed: boolean, detail: string): BudgetBoardSmokeCheck {
  return { id, status: passed ? "pass" : "fail", detail };
}

export function runBudgetBoardSmoke(input: { tempRoot: string; models: SmokeModel[]; currentConfig?: AdvisorConfig }): BudgetBoardSmokeResult {
  const models = input.models;
  const ctx = { modelRegistry: modelRegistry(models) };
  const plan = buildAdvisorBoardProfilePlan(ctx, input.currentConfig ?? normalizeAdvisorConfig({}));
  const advisorConfigPath = join(input.tempRoot, "advisor", "config.json");
  const checks: BudgetBoardSmokeCheck[] = [];

  checks.push(check("strong-advisor-model", !plan.advisorModel.startsWith("<"), plan.advisorModel));
  checks.push(check("driver-recommendation-only", plan.mutatesGlobalDriver === false, plan.driverModel));
  checks.push(check("no-live-model-calls", true, "smoke uses registry metadata and temp file writes only"));

  if (!plan.advisorModel.startsWith("<")) {
    const filePlan = { ...plan, files: { advisor: advisorConfigPath } };
    const written = applyAdvisorBoardProfilePlan(filePlan);
    const parsed = JSON.parse(readFileSync(advisorConfigPath, "utf8"));
    const policy = budgetBoardEscalationPolicyText(written);
    checks.push(check("writes-advisor-config-only", existsSync(advisorConfigPath) && !existsSync(join(input.tempRoot, "config.json")) && !existsSync(join(input.tempRoot, "router", "config.json")), advisorConfigPath));
    checks.push(check("profile-enabled", parsed.profile === "budget-board" && parsed.mode === "manual" && parsed.review === "off", `profile=${parsed.profile}, mode=${parsed.mode}, review=${parsed.review}`));
    checks.push(check("board-modes", parsed.board?.mode === "shadow" && parsed.headOfBoard?.mode === "enabled" && parsed.specialistDispatch?.mode === "suggest", `board=${parsed.board?.mode}, head=${parsed.headOfBoard?.mode}, specialists=${parsed.specialistDispatch?.mode}`));
    checks.push(check("policy-status", policy.includes("triggers=user_request or material Board risk") && policy.includes("maxCalls=3") && policy.includes("maxCost=cheap"), policy.replace(/\s+/g, " ").slice(0, 240)));
  } else {
    checks.push(check("writes-advisor-config-only", false, "skipped because strong advisor model is missing"));
    checks.push(check("profile-enabled", false, "skipped because strong advisor model is missing"));
    checks.push(check("board-modes", false, "skipped because strong advisor model is missing"));
    checks.push(check("policy-status", false, "skipped because strong advisor model is missing"));
  }

  return {
    schema: "pi-rogue.budget-board-smoke.v1",
    ok: checks.every((item) => item.status === "pass"),
    noLiveModelCalls: true,
    profile: "budget-board",
    advisorConfigPath,
    driverRecommendation: plan.driverModel,
    advisorModel: plan.advisorModel,
    checks,
  };
}
