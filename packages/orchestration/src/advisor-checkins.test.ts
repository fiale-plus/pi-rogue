import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { advisorCheckinDemandStatus, resetAdvisorSessionContext, setAdvisorCheckinDemand, setAdvisorCheckinsEnabled } from "./advisor-checkins.js";

const dirs: string[] = [];

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-checkins-"));
  dirs.push(dir);
  const file = join(dir, "advisor", "config.json");
  mkdirSync(join(dir, "advisor"), { recursive: true });
  return file;
}

function demandCtx(name: string) {
  return { sessionManager: { getSessionFile: () => join(tmpdir(), `${name}.jsonl`) } };
}

function tempDemandStorage() {
  const file = tempConfig();
  return {
    config: file,
    demand: join(dirname(file), "checkin-demand.json"),
    sessions: join(dirname(dirname(file)), "orchestration"),
  };
}

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), "pi-rogue-advisor-state-"));
  dirs.push(dir);
  const base = join(dir, "advisor");
  mkdirSync(base, { recursive: true });
  return {
    config: join(base, "config.json"),
    state: join(base, "state.json"),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("advisor check-in lifecycle bridge", () => {
  it("turns advisor check-ins on while preserving existing config and captures start time", () => {
    const file = tempConfig();
    writeFileSync(file, JSON.stringify({
      mode: "auto",
      review: "light",
      model: "openai-codex/gpt-5.5",
      checkinIntervalTurns: 3,
    }), "utf8");
    const startedAt = Date.now();

    const next = setAdvisorCheckinsEnabled(true, file);

    expect(next).toMatchObject({ mode: "auto", review: "light", model: "openai-codex/gpt-5.5", checkins: "mid-hour" });
    expect(next.checkinIntervalTurns).toBeUndefined();
    expect(next.checkinStartedAt).toBeTypeOf("number");
    expect(next.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.checkins).toBe("mid-hour");
    expect(parsed.checkinIntervalTurns).toBeUndefined();
    expect(parsed.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);
  });

  it("turns advisor check-ins off", () => {
    const file = tempConfig();
    writeFileSync(file, JSON.stringify({ checkins: "mid-hour", checkinIntervalMinutes: 30 }), "utf8");

    const next = setAdvisorCheckinsEnabled(false, file);

    expect(next).toMatchObject({ checkins: "off", checkinIntervalMinutes: 30 });
    expect(JSON.parse(readFileSync(file, "utf8")).checkins).toBe("off");
  });

  it("aggregates persisted demand across sessions and preserves the global timer", () => {
    const file = tempConfig();
    const demand = join(dirname(file), "checkin-demand.json");
    const first = demandCtx("checkin-demand-a");
    const second = demandCtx("checkin-demand-b");

    const enabled = setAdvisorCheckinDemand(first, "goal", true, file, demand);
    const startedAt = enabled.checkinStartedAt;
    setAdvisorCheckinDemand(second, "loop", true, file, demand);
    const afterSecondClears = setAdvisorCheckinDemand(second, "loop", false, file, demand);

    expect(afterSecondClears.checkins).toBe("mid-hour");
    expect(afterSecondClears.checkinStartedAt).toBe(startedAt);
    expect(Object.keys(JSON.parse(readFileSync(demand, "utf8")).sessions)).toHaveLength(1);

    const disabled = setAdvisorCheckinDemand(first, "goal", false, file, demand);
    expect(disabled.checkins).toBe("off");
    expect(Object.keys(JSON.parse(readFileSync(demand, "utf8")).sessions)).toHaveLength(0);
  });

  it("recomputes global enablement from persisted ownership after restart", () => {
    const file = tempConfig();
    const demand = join(dirname(file), "checkin-demand.json");
    const first = demandCtx("restart-demand-a");
    const inactive = demandCtx("restart-demand-b");

    setAdvisorCheckinDemand(first, "goal", true, file, demand);
    writeFileSync(file, JSON.stringify({ checkins: "off", checkinIntervalMinutes: 30 }), "utf8");

    const recovered = setAdvisorCheckinDemand(inactive, "loop", false, file, demand);
    expect(recovered.checkins).toBe("mid-hour");
    expect(recovered.checkinStartedAt).toBeTypeOf("number");
  });

  it("keeps goal and loop demand independent without resetting during ownership transfer", () => {
    const file = tempConfig();
    const demand = join(dirname(file), "checkin-demand.json");
    const ctx = demandCtx("same-session-demand");

    const loopEnabled = setAdvisorCheckinDemand(ctx, "loop", true, file, demand);
    setAdvisorCheckinDemand(ctx, "goal", true, file, demand);
    const transferred = setAdvisorCheckinDemand(ctx, "loop", false, file, demand);
    expect(transferred.checkins).toBe("mid-hour");
    expect(transferred.checkinStartedAt).toBe(loopEnabled.checkinStartedAt);
    expect(setAdvisorCheckinDemand(ctx, "goal", false, file, demand).checkins).toBe("off");
  });

  it("expires an old orphan while another session starts and stops", () => {
    const { config, demand, sessions } = tempDemandStorage();
    writeFileSync(demand, JSON.stringify({
      version: 1,
      sessions: {
        "v2-pi-rogue-race-orphan-0123456789abcdef": { goal: true, updatedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString() },
      },
    }), "utf8");
    const other = demandCtx("lease-other-session");

    setAdvisorCheckinDemand(other, "loop", true, config, demand, sessions);
    const stopped = setAdvisorCheckinDemand(other, "loop", false, config, demand, sessions);

    expect(stopped.checkins).toBe("off");
    expect(JSON.parse(readFileSync(demand, "utf8")).sessions).toEqual({});
  });

  it("retains an old owner backed by resumable goal state and reports it concisely", () => {
    const { config, demand, sessions } = tempDemandStorage();
    const owner = "v2-resumable-goal-0123456789abcdef";
    mkdirSync(join(sessions, owner), { recursive: true });
    writeFileSync(join(sessions, owner, "goal.md"), "resume after restart\n", "utf8");
    writeFileSync(demand, JSON.stringify({
      version: 1,
      sessions: { [owner]: { goal: true, updatedAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString() } },
    }), "utf8");

    const status = advisorCheckinDemandStatus(config, demand, sessions);

    expect(status).toEqual({ enabled: true, owners: ["resumable-goal (goal)"] });
    expect(JSON.parse(readFileSync(config, "utf8")).checkins).toBe("mid-hour");
    expect(Date.parse(JSON.parse(readFileSync(demand, "utf8")).sessions[owner].updatedAt)).toBeGreaterThan(Date.now() - 5_000);
  });

  it("releases a gracefully stopped owner even when its goal remains resumable", () => {
    const { config, demand, sessions } = tempDemandStorage();
    const ctx = demandCtx("graceful-owner");
    setAdvisorCheckinDemand(ctx, "goal", true, config, demand, sessions);
    const key = Object.keys(JSON.parse(readFileSync(demand, "utf8")).sessions)[0];
    mkdirSync(join(sessions, key), { recursive: true });
    writeFileSync(join(sessions, key, "goal.md"), "resume later\n", "utf8");

    const stopped = setAdvisorCheckinDemand(ctx, "goal", false, config, demand, sessions);

    expect(stopped.checkins).toBe("off");
    expect(JSON.parse(readFileSync(demand, "utf8")).sessions).toEqual({});
  });

  it("drops malformed and implausibly future leases without letting clock skew hold check-ins on", () => {
    const { config, demand, sessions } = tempDemandStorage();
    writeFileSync(demand, JSON.stringify({
      version: 1,
      sessions: {
        "v2-malformed-time-0123456789abcdef": { goal: true, updatedAt: "not-a-date" },
        "v2-future-time-0123456789abcdef": { loop: true, updatedAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() },
      },
    }), "utf8");

    expect(advisorCheckinDemandStatus(config, demand, sessions)).toEqual({ enabled: false, owners: [] });
    expect(JSON.parse(readFileSync(config, "utf8")).checkins).toBe("off");
    expect(JSON.parse(readFileSync(demand, "utf8")).sessions).toEqual({});
  });

  it("serializes concurrent demand writers without dropping either owner", async () => {
    const { config, demand, sessions } = tempDemandStorage();
    const worker = join(dirname(demand), "concurrent-demand-writer.ts");
    writeFileSync(worker, [
      `import { setAdvisorCheckinDemand } from ${JSON.stringify(new URL("./advisor-checkins.ts", import.meta.url).href)};`,
      'import { join } from "node:path";',
      "const [config, demand, sessions, name] = process.argv.slice(2);",
      'setAdvisorCheckinDemand({ sessionManager: { getSessionFile: () => join("/tmp", `${name}.jsonl`) } }, "goal", true, config, demand, sessions);',
    ].join("\n"), "utf8");
    const run = (name: string) => new Promise<void>((resolveRun, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", worker, config, demand, sessions, name], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`writer exited ${code}`)));
    });

    await Promise.all([run("concurrent-a"), run("concurrent-b")]);

    expect(Object.keys(JSON.parse(readFileSync(demand, "utf8")).sessions)).toHaveLength(2);
    expect(JSON.parse(readFileSync(config, "utf8")).checkins).toBe("mid-hour");
  });

  it("fails safely without overwriting config or top-level malformed demand", () => {
    const file = tempConfig();
    const demand = join(dirname(file), "checkin-demand.json");
    writeFileSync(file, JSON.stringify({ checkins: "mid-hour", checkinStartedAt: 123 }), "utf8");
    writeFileSync(demand, "null\n", "utf8");

    expect(() => setAdvisorCheckinDemand(demandCtx("malformed-demand"), "loop", false, file, demand))
      .toThrow(/Invalid advisor check-in demand registry/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ checkins: "mid-hour", checkinStartedAt: 123 });
    expect(readFileSync(demand, "utf8")).toBe("null\n");
  });

  it("fails safely on malformed nested ownership instead of discarding it", () => {
    const file = tempConfig();
    const demand = join(dirname(file), "checkin-demand.json");
    const malformed = { version: 1, sessions: { other: { goal: "true", updatedAt: "2026-07-11T00:00:00.000Z" } } };
    writeFileSync(file, JSON.stringify({ checkins: "mid-hour", checkinStartedAt: 456 }), "utf8");
    writeFileSync(demand, JSON.stringify(malformed), "utf8");

    expect(() => setAdvisorCheckinDemand(demandCtx("unrelated-demand"), "loop", false, file, demand))
      .toThrow(/Invalid advisor check-in demand registry entry/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ checkins: "mid-hour", checkinStartedAt: 456 });
    expect(JSON.parse(readFileSync(demand, "utf8"))).toEqual(malformed);
  });

  it("preserves legacy one-argument reset signature", () => {
    const { config } = tempState();
    writeFileSync(config, JSON.stringify({ checkins: "off" }), "utf8");

    const next = resetAdvisorSessionContext(config);

    expect(next.config.checkins).toBe("off");
    expect(JSON.parse(readFileSync(config, "utf8")).checkins).toBe("off");
  });

  it("resets advisor brief context and check-in timing for a new goal", () => {
    const { config, state } = tempState();
    const startedAt = Date.now();
    writeFileSync(config, JSON.stringify({
      mode: "auto",
      review: "light",
      checkins: "mid-hour",
      checkinIntervalMinutes: 30,
      checkinIntervalTurns: 3,
      checkinStartedAt: 1,
    }), "utf8");
    writeFileSync(state, JSON.stringify({
      turns: 9,
      lastTask: "old task",
      notes: ["old note"],
      files: ["old.ts"],
      errors: ["old error"],
      advisorCalls: 3,
      cacheHits: 7,
      followUp: "old follow-up",
      reviewControl: {
        status: "running",
        pending: true,
        consumed: false,
        running: true,
        lastDecision: "review",
        lastReason: "manual checkpoint",
      },
      router: { preflight: { label: "continue" } },
      checkin: {
        lastAt: "2026-05-29T00:00:00.000Z",
        lastTurn: 8,
        lastReason: "mid-hour check-in after 1 new turn(s)",
        queued: true,
        queuedReason: "queued mid-session check-in",
      },
    }), "utf8");

    const next = resetAdvisorSessionContext(config, state);

    expect(next.state).toMatchObject({
      turns: 0,
      lastTask: "",
      notes: [],
      files: [],
      errors: [],
      advisorCalls: 3,
      cacheHits: 7,
      followUp: "",
      router: {},
      checkin: { queued: false },
      reviewControl: {
        status: "idle",
        pending: false,
        consumed: true,
        running: false,
      },
    });
    expect(next.config.checkinStartedAt).toBeTypeOf("number");
    expect(next.config.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);

    const parsedState = JSON.parse(readFileSync(state, "utf8"));
    expect(parsedState.lastTask).toBe("");
    expect(parsedState.notes).toEqual([]);
    expect(parsedState.checkin).toEqual({ queued: false });
    expect(parsedState.reviewControl).toEqual({
      status: "idle",
      pending: false,
      consumed: true,
      running: false,
    });

    const parsedConfig = JSON.parse(readFileSync(config, "utf8"));
    expect(parsedConfig.checkins).toBe("mid-hour");
    expect(parsedConfig.checkinIntervalTurns).toBeUndefined();
    expect(parsedConfig.checkinStartedAt).toBeGreaterThanOrEqual(startedAt);
  });
});
