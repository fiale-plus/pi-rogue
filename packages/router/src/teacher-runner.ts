import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hashText } from "./hash.js";
import { TEACHER_LABEL_SCHEMA, type TeacherLabel, type TeacherPromptRequest } from "./learning.js";
import type { AdviceShape, ContextPolicy, RouteAction, RouteDecision } from "./types.js";

const ROUTE_ACTIONS = new Set<RouteAction>([
  "continue_current",
  "continue_local",
  "summarize_context",
  "run_verifier",
  "ask_micro_hint",
  "escalate_plan_critique",
  "escalate_debug_diagnosis",
  "escalate_diff_review",
  "delegate_full_step",
  "spawn_subagent",
  "merge_subagent_result",
  "stop_and_ask_user",
]);
const ADVICE_SHAPES = new Set<AdviceShape>(["none", "micro_hint", "plan_critique", "debug_diagnosis", "diff_review", "full_delegation"]);
const CONTEXT_POLICIES = new Set<ContextPolicy>(["none", "minimal", "recent_events", "focused_error_and_diff", "diff_only", "session_summary", "full_context"]);

export const TEACHER_RUN_SUMMARY_SCHEMA = "pi-router.teacher-run-summary.v1" as const;

export interface TeacherLabelFailure {
  schema: "pi-router.teacher-label-failure.v1";
  requestId: string;
  checkpointId: string;
  sessionId: string;
  teacher: string;
  generatedAt: string;
  attempts: number;
  error: string;
}

export interface TeacherRunSummary {
  schema: typeof TEACHER_RUN_SUMMARY_SCHEMA;
  teacher: string;
  teachers: string[];
  requests: number;
  decisions: number;
  labels: number;
  failures: number;
  maxAttempts: number;
  decisionsOutput: string;
  labelsOutput: string;
  failuresOutput?: string;
  failureSamples: TeacherLabelFailure[];
  dryRun: boolean;
}

export interface TeacherModelExecutor {
  (input: { request: TeacherPromptRequest; prompt: string; teacher: string }): string | Promise<string>;
}

export function readTeacherPromptRequests(path: string): TeacherPromptRequest[] {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`teacher request file not found: ${path}`);
  return readFileSync(resolved, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TeacherPromptRequest);
}

function writeJsonl(path: string, rows: unknown[]): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

function readRawSessionSpan(request: TeacherPromptRequest, maxBytes = 20_000): { text: string; truncated: boolean } | null {
  const { path, fromByte, toByte } = request.rawSessionRef;
  const spanBytes = Math.max(0, toByte - fromByte);
  const length = Math.min(maxBytes, spanBytes);
  if (!path || length <= 0) return null;
  const truncated = spanBytes > maxBytes;
  const offset = truncated ? Math.max(fromByte, toByte - length) : fromByte;
  let fd: number | undefined;
  try {
    fd = openSync(resolve(path), "r");
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, offset);
    return { text: buffer.subarray(0, bytes).toString("utf8"), truncated };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function teacherPromptText(request: TeacherPromptRequest): string {
  const span = readRawSessionSpan(request);
  return [
    "You are labeling a Pi router checkpoint for model routing.",
    "Return exactly one JSON object matching pi-router.decision.v1 and no markdown.",
    "Use the bounded raw session span as evidence, but do not quote transcript text in the reason; summarize evidence only.",
    `Allowed actions: ${request.allowedActions.join(", ")}`,
    request.instruction,
    "Request:",
    JSON.stringify(request, null, 2),
    "Bounded raw session span (not persisted by the router; do not quote it in output):",
    span ? `${span.text}${span.truncated ? "\n[truncated]" : ""}` : "[unavailable]",
  ].join("\n\n");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to object slicing; models often append prose after a valid JSON object.
    }
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("teacher response did not contain a JSON object");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decisionCandidate(value: unknown): Partial<RouteDecision> {
  if (Array.isArray(value)) {
    const firstObject = value.find((item) => asRecord(item));
    if (firstObject) return decisionCandidate(firstObject);
  }
  const record = asRecord(value);
  if (!record) return {};
  if (record.schema === "pi-router.decision.v1") return record as Partial<RouteDecision>;
  if (typeof record.content === "string") {
    try {
      return decisionCandidate(extractJsonObject(record.content));
    } catch {
      // Continue with the current object below.
    }
  }
  for (const key of ["decision", "routeDecision", "teacherDecision", "label", "output"]) {
    const nested = record[key];
    if (asRecord(nested) || Array.isArray(nested) || typeof nested === "string") {
      if (typeof nested === "string") {
        try {
          return decisionCandidate(extractJsonObject(nested));
        } catch {
          continue;
        }
      }
      return decisionCandidate(nested);
    }
  }
  return record as Partial<RouteDecision>;
}

function teacherPolicyVersion(request: TeacherPromptRequest): string {
  return `teacher/${request.teacher}/request/${request.requestId}`.replace(/\s+/g, "-");
}

function sanitizeRationale(text: string): string {
  // Do not persist free-form teacher rationale: the prompt includes a raw session span,
  // so even unquoted excerpts would violate the router's derived-artifact privacy rule.
  return `teacher rationale redacted; rationaleHash=${hashText(text)}`;
}

function sanitizeFailureError(error: Error): string {
  const message = error.message.replace(/\s+/g, " ").trim();
  if (message.startsWith("teacher decision has invalid schema")) return `teacher decision has invalid schema; errorHash=${hashText(message)}`;
  if (message.startsWith("teacher decision checkpoint mismatch")) return `teacher decision checkpoint mismatch; errorHash=${hashText(message)}`;
  if (message.startsWith("teacher decision action not allowed")) return `teacher decision action not allowed; errorHash=${hashText(message)}`;
  if (message.startsWith("teacher decision adviceShape invalid")) return `teacher decision adviceShape invalid; errorHash=${hashText(message)}`;
  if (message.startsWith("teacher decision contextPolicy invalid")) return `teacher decision contextPolicy invalid; errorHash=${hashText(message)}`;
  if (message.startsWith("teacher decision confidence invalid")) return `teacher decision confidence invalid; errorHash=${hashText(message)}`;
  if (message.startsWith("teacher decision missing reason")) return `teacher decision missing reason; errorHash=${hashText(message)}`;
  return `teacher labeling failed; errorHash=${hashText(message)}`;
}

export function parseTeacherDecision(request: TeacherPromptRequest, text: string): RouteDecision {
  const value = decisionCandidate(extractJsonObject(text));
  if (value.schema !== "pi-router.decision.v1") throw new Error(`teacher decision has invalid schema for ${request.checkpointId}`);
  if (value.checkpointId !== request.checkpointId) throw new Error(`teacher decision checkpoint mismatch for ${request.checkpointId}`);
  const allowedActions = request.allowedActions.filter((action): action is RouteAction => ROUTE_ACTIONS.has(action));
  if (!value.action || !ROUTE_ACTIONS.has(value.action) || !allowedActions.includes(value.action)) throw new Error(`teacher decision action not allowed for ${request.checkpointId}: ${String(value.action)}`);
  if (!value.adviceShape || !ADVICE_SHAPES.has(value.adviceShape)) throw new Error(`teacher decision adviceShape invalid for ${request.checkpointId}`);
  if (!value.contextPolicy || !CONTEXT_POLICIES.has(value.contextPolicy)) throw new Error(`teacher decision contextPolicy invalid for ${request.checkpointId}`);
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) throw new Error(`teacher decision confidence invalid for ${request.checkpointId}`);
  if (typeof value.reason !== "string" || !value.reason.trim()) throw new Error(`teacher decision missing reason for ${request.checkpointId}`);
  return {
    schema: "pi-router.decision.v1",
    checkpointId: request.checkpointId,
    action: value.action,
    adviceShape: value.adviceShape,
    contextPolicy: value.contextPolicy,
    confidence: Number(value.confidence.toFixed(3)),
    reason: sanitizeRationale(value.reason),
    policyVersion: teacherPolicyVersion(request),
  };
}

export function labelFromTeacherDecision(request: TeacherPromptRequest, decision: RouteDecision, generatedAt: string): TeacherLabel {
  return {
    schema: TEACHER_LABEL_SCHEMA,
    labelId: hashText("teacher-label", request.teacher, request.requestId, decision.action, request.rawSessionRef.contentHash),
    generatedAt,
    teacher: request.teacher,
    checkpointId: request.checkpointId,
    sessionId: request.sessionId,
    rawSessionRef: request.rawSessionRef,
    suggestedAction: decision.action,
    confidence: decision.confidence,
    rationale: decision.reason,
    source: "teacher-output",
  };
}

export function defaultPiTeacherExecutor(input: { request: TeacherPromptRequest; prompt: string; teacher: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-router-teacher-"));
  const promptPath = join(dir, "prompt.md");
  try {
    writeFileSync(promptPath, input.prompt, { mode: 0o600 });
    return execFileSync("pi", [
      "-p",
      "--no-session",
      "--no-tools",
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--model",
      input.teacher,
      `@${promptPath}`,
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runTeacherLabeling(options: {
  requestsPath: string;
  decisionsOutputPath: string;
  labelsOutputPath: string;
  teacher?: string;
  dryRun?: boolean;
  generatedAt?: string;
  executor?: TeacherModelExecutor;
  maxAttempts?: number;
  failuresOutputPath?: string;
}): Promise<TeacherRunSummary> {
  const requests = readTeacherPromptRequests(options.requestsPath).map((request) => options.teacher ? { ...request, teacher: options.teacher } : request);
  const teachers = [...new Set(requests.map((request) => request.teacher))].sort();
  const teacher = teachers.length === 1 ? teachers[0] : teachers.length > 1 ? "mixed" : options.teacher ?? "openai-codex/gpt-5.5";
  const executor = options.executor ?? defaultPiTeacherExecutor;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
  const failuresOutput = options.failuresOutputPath ? resolve(options.failuresOutputPath) : undefined;

  if (options.dryRun) {
    writeJsonl(options.decisionsOutputPath, []);
    writeJsonl(options.labelsOutputPath, []);
    if (options.failuresOutputPath) writeJsonl(options.failuresOutputPath, []);
    return {
      schema: TEACHER_RUN_SUMMARY_SCHEMA,
      teacher,
      teachers,
      requests: requests.length,
      decisions: 0,
      labels: 0,
      failures: 0,
      maxAttempts,
      decisionsOutput: resolve(options.decisionsOutputPath),
      labelsOutput: resolve(options.labelsOutputPath),
      failuresOutput,
      failureSamples: [],
      dryRun: true,
    };
  }

  const decisions: RouteDecision[] = [];
  const labels: TeacherLabel[] = [];
  const failures: TeacherLabelFailure[] = [];
  for (const request of requests) {
    const basePrompt = teacherPromptText(request);
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt = attempt === 1
        ? basePrompt
        : [
          basePrompt,
          "Previous response failed validation.",
          `Validation error: ${lastError ? sanitizeFailureError(lastError) : "unknown error"}`,
          "Retry by returning exactly one valid pi-router.decision.v1 JSON object and no markdown.",
        ].join("\n\n");
      let response: string;
      try {
        response = await executor({ request, prompt, teacher: request.teacher });
      } catch (error) {
        const executorError = error instanceof Error ? error : new Error(String(error));
        throw new Error(`teacher executor failed for ${request.checkpointId}; ${sanitizeFailureError(executorError)}`);
      }
      try {
        const decision = parseTeacherDecision(request, response);
        decisions.push(decision);
        labels.push(labelFromTeacherDecision(request, decision, generatedAt));
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (lastError) {
      failures.push({
        schema: "pi-router.teacher-label-failure.v1",
        requestId: request.requestId,
        checkpointId: request.checkpointId,
        sessionId: request.sessionId,
        teacher: request.teacher,
        generatedAt,
        attempts: maxAttempts,
        error: sanitizeFailureError(lastError),
      });
    }
  }
  writeJsonl(options.decisionsOutputPath, decisions);
  writeJsonl(options.labelsOutputPath, labels);
  if (options.failuresOutputPath) writeJsonl(options.failuresOutputPath, failures);
  return {
    schema: TEACHER_RUN_SUMMARY_SCHEMA,
    teacher,
    teachers,
    requests: requests.length,
    decisions: decisions.length,
    labels: labels.length,
    failures: failures.length,
    maxAttempts,
    decisionsOutput: resolve(options.decisionsOutputPath),
    labelsOutput: resolve(options.labelsOutputPath),
    failuresOutput,
    failureSamples: failures.slice(0, 20),
    dryRun: false,
  };
}
