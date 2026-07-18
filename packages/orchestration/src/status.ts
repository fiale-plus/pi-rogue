import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFeatureStatusV1, serializeFeatureStatusV1, sessionIdentity, type FeatureStatusV1 } from "@fiale-plus/pi-core";

const FEATURE = "orchestration";
const STATE_FILES = ["goal.md", "loop.json", "autoresearch.json", "worker.json"] as const;
type StateFile = (typeof STATE_FILES)[number];
type FileRead = { present: boolean; valid: boolean; text?: string; value?: Record<string, unknown> };

function hasOnlyTypedFields(value: Record<string, unknown>, fields: Record<string, "boolean" | "number" | "string">): boolean {
  return Object.entries(fields).every(([field, type]) => value[field] === undefined || typeof value[field] === type);
}

function validLoopInterval(interval: unknown): boolean {
  if (typeof interval !== "string" || !interval.trim()) return false;
  const match = interval.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return false;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return false;
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * multiplier) >= 60_000;
}

function validStateValue(file: StateFile, value: Record<string, unknown>): boolean {
  if (file === "loop.json") {
    return hasOnlyTypedFields(value, { enabled: "boolean", interval: "string", instruction: "string", updatedAt: "string", generation: "number" })
      && (value.generation === undefined || Number.isFinite(value.generation))
      && (value.enabled !== true || validLoopInterval(value.interval));
  }
  if (file === "autoresearch.json") {
    return hasOnlyTypedFields(value, {
      kind: "string", instruction: "string", goal: "string", loopInstruction: "string", interval: "string", cycles: "number", evidenceCycles: "number", updatedAt: "string",
    })
      && (value.cycles === undefined || Number.isFinite(value.cycles))
      && (value.evidenceCycles === undefined || Number.isFinite(value.evidenceCycles))
      && (value.recordedCycleIds === undefined || (Array.isArray(value.recordedCycleIds) && value.recordedCycleIds.every((id) => typeof id === "string")))
      && (value.lastResult === undefined || value.lastResult === "done" || value.lastResult === "continue" || value.lastResult === "unknown");
  }
  return hasOnlyTypedFields(value, { enabled: "boolean", model: "string", scope: "string", approvedAt: "string", updatedAt: "string" })
    && (value.scope === undefined || value.scope === "session");
}

type StateDirectory = { path: string; safe: boolean };

function safeDirectory(path: string): boolean {
  try {
    const directory = lstatSync(path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory() && !safeDirectory(child)) return false;
      if (!stat.isDirectory() && !stat.isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function stateDirectory(ctx: any): StateDirectory {
  const identity = sessionIdentity(ctx);
  const root = join(homedir(), ".pi", "agent", "fiale-plus", FEATURE);
  const candidates = [identity.key, identity.priorCoreKey, identity.legacyKey]
    .filter((key, index, all) => all.indexOf(key) === index)
    .map((key) => join(root, key));
  if (existsSync(candidates[0])) return { path: candidates[0], safe: safeDirectory(candidates[0]) };

  for (const candidate of candidates.slice(1)) {
    if (!existsSync(candidate)) continue;
    if (!safeDirectory(candidate)) break;
    try {
      const claimPath = join(candidate, ".pi-rogue-v2-claim");
      // Unclaimed legacy directories are ambiguous across sessions; only read a directory
      // after normal storage migration has recorded this session's ownership claim.
      if (!existsSync(claimPath)) break;
      const claim = lstatSync(claimPath);
      if (claim.isFile() && !claim.isSymbolicLink() && readFileSync(claimPath, "utf8").trim() === identity.key) {
        return { path: candidate, safe: true };
      }
    } catch {
      // Treat unreadable or foreign legacy state as unavailable to this session.
    }
    break;
  }

  return { path: candidates[0], safe: !existsSync(candidates[0]) || safeDirectory(candidates[0]) };
}

function readStateFile(path: string, json: boolean, validator?: (value: Record<string, unknown>) => boolean): FileRead {
  if (!existsSync(path)) return { present: false, valid: true };
  try {
    const text = readFileSync(path, "utf8");
    if (!json) return { present: true, valid: true, text };
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { present: true, valid: validator ? validator(value as Record<string, unknown>) : true, value: value as Record<string, unknown> }
      : { present: true, valid: false };
  } catch {
    return { present: true, valid: false };
  }
}

function stateMap(ctx: any): Record<StateFile, FileRead> {
  const directory = stateDirectory(ctx);
  if (!directory.safe) {
    return Object.fromEntries(STATE_FILES.map((file) => [file, { present: true, valid: false }])) as Record<StateFile, FileRead>;
  }
  return {
    "goal.md": readStateFile(join(directory.path, "goal.md"), false),
    "loop.json": readStateFile(join(directory.path, "loop.json"), true, (value) => validStateValue("loop.json", value)),
    "autoresearch.json": readStateFile(join(directory.path, "autoresearch.json"), true, (value) => validStateValue("autoresearch.json", value)),
    "worker.json": readStateFile(join(directory.path, "worker.json"), true, (value) => validStateValue("worker.json", value)),
  };
}

/** Read-only Orchestration status adapter. It never creates, migrates, or writes state. */
export function orchestrationFeatureStatus(ctx: any): FeatureStatusV1 {
  const files = stateMap(ctx);
  const goal = Boolean(files["goal.md"].text?.trim());
  const loop = files["loop.json"].value;
  const research = files["autoresearch.json"].value;
  const worker = files["worker.json"].value;
  const loopActive = loop?.enabled === true && typeof loop?.instruction === "string" && loop.instruction.trim().length > 0;
  const researchActive = typeof research?.instruction === "string" && research.instruction.trim().length > 0;
  const workerActive = worker?.enabled === true && typeof worker.model === "string" && worker.model.trim().length > 0;
  const invalid = Object.values(files).some((file) => !file.valid);
  const active = goal || loopActive || researchActive || workerActive;
  const hasSessionIdentity = Boolean(ctx?.sessionManager?.getSessionFile?.() || ctx?.session?.id || process.env.PI_ROGUE_SESSION_ID);

  return createFeatureStatusV1({
    feature: "orchestration",
    owner: "orchestration",
    health: invalid ? "error" : !hasSessionIdentity ? "degraded" : active ? "ready" : "idle",
    enabled: true,
    mode: active ? "active" : "idle",
    summary: active ? "orchestration has active session work" : "no active orchestration work",
    diagnostics: {
      stateFiles: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file.present ? (file.valid ? "present" : "invalid") : "missing"])),
      goalActive: goal,
      loopActive,
      researchActive,
      workerActive,
      sessionScoped: hasSessionIdentity,
    },
  });
}

export function serializeOrchestrationFeatureStatus(ctx: any): string {
  return serializeFeatureStatusV1(orchestrationFeatureStatus(ctx));
}
