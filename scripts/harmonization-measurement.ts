import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceIdFor } from "../packages/context-broker/src/index.js";
import { reviewWorkerResult } from "../packages/advisor/src/worker-review.js";
import { orchestrationFeatureStatus } from "../packages/orchestration/src/status.js";
import { decideRoute } from "../packages/router/src/decision.js";
import { routerFeatureStatus } from "../packages/router/src/status.js";
import { routerGlobalConfigPath, routerStatePath } from "../packages/router/src/config.js";
import type { RouterCheckpoint } from "../packages/router/src/types.js";
import type { FeatureStatusV1 } from "../packages/core/src/feature-status.js";
import type { ContextArtifactInput } from "../packages/core/src/context-broker.js";

export const HARMONIZATION_MEASUREMENT_SCHEMA = "pi-rogue.harmonization-observation.v1" as const;

export type MeasurementOperation =
  | "router_status"
  | "router_decision"
  | "orchestration_status"
  | "worker_review"
  | "context_source"
  | "unknown_feature";

export interface MeasurementObservation {
  fixtureId: string;
  request: {
    feature: string;
    operation: MeasurementOperation;
    optionalInput: "absent" | "present" | "empty";
    correlationConflict: boolean;
  };
  authority: "router" | "orchestration" | "advisor" | "context-broker" | "none";
  route?: string;
  defaults: Record<string, boolean | number | string | null>;
  response: Record<string, boolean | number | string | null | string[]>;
  correlation: {
    sessionIdHash?: string;
    repoHash?: string;
    conflict: boolean;
  };
}

export interface HarmonizationMeasurementReport {
  schema: typeof HARMONIZATION_MEASUREMENT_SCHEMA;
  harnessEnabled: boolean;
  observations: MeasurementObservation[];
}

type Fixture =
  | { id: string; feature: "router"; operation: "router_status"; sessionId?: string; state?: "malformed"; optionalInput: MeasurementObservation["request"]["optionalInput"] }
  | { id: string; feature: "router"; operation: "router_decision"; route: "explicit" | "default"; checkpoint: RouterCheckpoint; optionalInput: MeasurementObservation["request"]["optionalInput"] }
  | { id: string; feature: "orchestration"; operation: "orchestration_status"; sessionId: string; optionalInput: MeasurementObservation["request"]["optionalInput"] }
  | { id: string; feature: "advisor"; operation: "worker_review"; sessionId?: string; observedSessionId?: string; optionalInput: MeasurementObservation["request"]["optionalInput"] }
  | { id: string; feature: "context-broker"; operation: "context_source"; sourceId?: string; optionalInput: MeasurementObservation["request"]["optionalInput"] }
  | { id: string; feature: "unknown"; operation: "unknown_feature"; optionalInput: MeasurementObservation["request"]["optionalInput"] };

const FIXTURE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function checkpoint(overrides: Partial<RouterCheckpoint["features"]> & Pick<RouterCheckpoint, "phase"> & Partial<Pick<RouterCheckpoint, "activeModel">>): RouterCheckpoint {
  return {
    schema: "pi-router.checkpoint.v1",
    sessionId: "fixture-session",
    checkpointId: `fixture-${overrides.phase}-${overrides.activeModel ? "explicit" : "default"}`,
    createdAt: FIXTURE_TIMESTAMP,
    rawSessionRef: {
      schema: "pi-router.raw-session-ref.v1",
      path: "<fixture-session>",
      fromEvent: 0,
      toEvent: 1,
      fromByte: 0,
      toByte: 1,
      contentHash: "fixture-content-hash",
    },
    harness: "pi",
    phase: overrides.phase,
    ...(overrides.activeModel ? { activeModel: overrides.activeModel } : {}),
    features: {
      sameCommandRepeatedCount: 0,
      sameErrorRepeatedCount: 0,
      errorChanged: false,
      testsImproved: true,
      filesTouched: 1,
      diffLines: 2,
      diffFilesChanged: 1,
      diffLinesAdded: 1,
      diffLinesDeleted: 1,
      diffChurnScore: 0.1,
      toolThrashScore: 0,
      goalDriftScore: 0,
      loopScore: 0.1,
      progressScore: 0.8,
      verifierUsed: true,
      noVerifierUsed: false,
      toolCallsLast10Turns: 1,
      turnIndex: 1,
      contextTokensApprox: 1_000,
      gitDirty: false,
      ...overrides,
    },
    recent: { touchedFileHashes: [] },
    sourceEvent: { index: 1, byteStart: 0, byteEnd: 1, type: "assistant", role: "assistant" },
  };
}

export const HARMONIZATION_FIXTURES: readonly Fixture[] = [
  { id: "router-status-unconfigured", feature: "router", operation: "router_status", optionalInput: "absent" },
  { id: "router-status-malformed", feature: "router", operation: "router_status", sessionId: "fixture-router", state: "malformed", optionalInput: "present" },
  {
    id: "router-decision-explicit-review",
    feature: "router",
    operation: "router_decision",
    route: "explicit",
    checkpoint: checkpoint({ phase: "review", activeModel: "frontier", diffLines: 500 }),
    optionalInput: "present",
  },
  {
    id: "router-decision-default-local",
    feature: "router",
    operation: "router_decision",
    route: "default",
    checkpoint: checkpoint({ phase: "implementation" }),
    optionalInput: "absent",
  },
  { id: "orchestration-status-idle", feature: "orchestration", operation: "orchestration_status", sessionId: "fixture-orchestration", optionalInput: "absent" },
  { id: "advisor-worker-review-minimal", feature: "advisor", operation: "worker_review", optionalInput: "absent" },
  { id: "advisor-worker-review-empty-optional", feature: "advisor", operation: "worker_review", optionalInput: "empty" },
  { id: "advisor-worker-review-conflicting-correlation", feature: "advisor", operation: "worker_review", sessionId: "outer-session", observedSessionId: "inner-session", optionalInput: "present" },
  { id: "context-source-optional-absent", feature: "context-broker", operation: "context_source", optionalInput: "absent" },
  { id: "context-source-explicit", feature: "context-broker", operation: "context_source", sourceId: "fixture-source", optionalInput: "present" },
  { id: "unknown-feature", feature: "unknown", operation: "unknown_feature", optionalInput: "empty" },
];

function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function withTemporaryHome<T>(run: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "pi-rogue-harmonization-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousHomeDrive = process.env.HOMEDRIVE;
  const previousHomePath = process.env.HOMEPATH;
  const previousSessionId = process.env.PI_ROGUE_SESSION_ID;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.HOMEDRIVE = "";
  process.env.HOMEPATH = "";
  delete process.env.PI_ROGUE_SESSION_ID;
  try {
    return run(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousHomeDrive === undefined) delete process.env.HOMEDRIVE;
    else process.env.HOMEDRIVE = previousHomeDrive;
    if (previousHomePath === undefined) delete process.env.HOMEPATH;
    else process.env.HOMEPATH = previousHomePath;
    if (previousSessionId === undefined) delete process.env.PI_ROGUE_SESSION_ID;
    else process.env.PI_ROGUE_SESSION_ID = previousSessionId;
    rmSync(home, { recursive: true, force: true });
  }
}

function statusResponse(status: FeatureStatusV1): { response: MeasurementObservation["response"]; defaults: MeasurementObservation["defaults"] } {
  const diagnostics = status.diagnostics ?? {};
  const response: MeasurementObservation["response"] = {
    health: status.health,
    enabled: status.enabled,
    mode: status.mode ?? null,
  };
  const defaults: MeasurementObservation["defaults"] = {
    configSource: typeof diagnostics.configSource === "string" ? diagnostics.configSource : null,
    configValid: typeof diagnostics.configValid === "boolean" ? diagnostics.configValid : null,
    statePresent: typeof diagnostics.statePresent === "boolean" ? diagnostics.statePresent : null,
    stateValid: typeof diagnostics.stateValid === "boolean" ? diagnostics.stateValid : null,
    sessionScoped: typeof diagnostics.sessionScoped === "boolean" ? diagnostics.sessionScoped : null,
  };
  return { response, defaults };
}

function baseObservation(fixture: Fixture, correlationConflict = false): MeasurementObservation {
  const sessionId = fixture.operation === "router_status" || fixture.operation === "orchestration_status"
    ? fixture.sessionId
    : fixture.operation === "worker_review"
      ? fixture.sessionId ?? fixture.observedSessionId
      : undefined;
  const repo = fixture.operation === "worker_review" ? fixture.observedSessionId : undefined;
  return {
    fixtureId: fixture.id,
    request: {
      feature: fixture.feature,
      operation: fixture.operation,
      optionalInput: fixture.optionalInput,
      correlationConflict,
    },
    authority: fixture.feature === "router"
      ? "router"
      : fixture.feature === "orchestration"
        ? "orchestration"
        : fixture.feature === "advisor"
          ? "advisor"
          : fixture.feature === "context-broker"
            ? "context-broker"
            : "none",
    defaults: {},
    response: {},
    correlation: {
      sessionIdHash: hashIdentifier(sessionId),
      repoHash: hashIdentifier(repo),
      conflict: correlationConflict,
    },
  };
}

export function measureFixture(fixture: Fixture): MeasurementObservation {
  if (fixture.operation === "unknown_feature") {
    return { ...baseObservation(fixture), response: { status: "unknown_feature" } };
  }

  if (fixture.operation === "router_status") {
    const observation = baseObservation(fixture);
    const status = withTemporaryHome(() => {
      const context = fixture.sessionId ? { session: { id: fixture.sessionId } } : {};
      if (fixture.state === "malformed") {
        const configPath = routerGlobalConfigPath();
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify({ enabled: true, mode: "observe" }), "utf8");
        const statePath = routerStatePath(context);
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, "{not-json", "utf8");
      }
      return routerFeatureStatus(context);
    });
    const normalized = statusResponse(status);
    return { ...observation, ...normalized };
  }

  if (fixture.operation === "orchestration_status") {
    const observation = baseObservation(fixture);
    const status = withTemporaryHome(() => orchestrationFeatureStatus({ session: { id: fixture.sessionId } }));
    const normalized = statusResponse(status);
    return { ...observation, ...normalized };
  }

  if (fixture.operation === "router_decision") {
    const decision = decideRoute(fixture.checkpoint);
    return {
      ...baseObservation(fixture),
      route: fixture.route,
      defaults: { policyVersion: decision.policyVersion, routeSelection: fixture.route },
      response: {
        action: decision.action,
        adviceShape: decision.adviceShape,
        contextPolicy: decision.contextPolicy,
        confidence: decision.confidence,
      },
    };
  }

  if (fixture.operation === "worker_review") {
    const conflict = Boolean(fixture.sessionId && fixture.observedSessionId && fixture.sessionId !== fixture.observedSessionId);
    const result = reviewWorkerResult({
      id: "fixture-worker",
      role: "reviewer",
      verdict: "green",
      summary: "fixture worker result",
      ...(fixture.optionalInput === "empty" ? { topic: "" } : {}),
      ...(fixture.sessionId || fixture.observedSessionId ? { sessionId: fixture.sessionId ?? fixture.observedSessionId } : {}),
      ...(fixture.sessionId || fixture.observedSessionId ? { repo: fixture.observedSessionId ?? fixture.sessionId } : {}),
    });
    const observation = baseObservation(fixture, conflict);
    observation.defaults = { workerAuthority: "advisor-review" };
    observation.response = {
      decision: result.decision.action,
      riskTypes: result.risks.map((risk) => risk.type).sort(),
      verdict: result.subagentSummary.verdict,
    };
    return observation;
  }

  const input: ContextArtifactInput = {
    sessionId: "fixture-session",
    kind: "tool_output",
    payload: "fixture payload",
    ...(fixture.sourceId !== undefined ? { sourceId: fixture.sourceId } : {}),
  };
  const sourceId = sourceIdFor(input);
  return {
    ...baseObservation(fixture),
    defaults: { sourceIdPresent: sourceId !== undefined, sourceIdValidated: true, producer: "context-broker" },
    response: { sourceIdHash: hashIdentifier(sourceId) ?? null },
  };
}

export function runHarmonizationMeasurement(harnessEnabled = true): HarmonizationMeasurementReport {
  return {
    schema: HARMONIZATION_MEASUREMENT_SCHEMA,
    harnessEnabled,
    observations: harnessEnabled ? HARMONIZATION_FIXTURES.map(measureFixture) : [],
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
}

export function serializeHarmonizationMeasurement(report: HarmonizationMeasurementReport): string {
  return JSON.stringify(canonicalize(report));
}

function outputPath(argv: string[]): string | undefined {
  const index = argv.indexOf("--output");
  return index >= 0 ? argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runHarmonizationMeasurement(!process.argv.includes("--disabled"));
  const serialized = `${serializeHarmonizationMeasurement(report)}\n`;
  const path = outputPath(process.argv.slice(2));
  if (path) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
}
