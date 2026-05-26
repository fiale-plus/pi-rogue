import { appendText, featureFile, readJson, readText, safeName, sessionKey, truncate, writeJson, writeText } from "@fiale-plus/pi-core";

const FEATURE = "brain";
const STATE_FILE = featureFile(FEATURE, "state.json");
const MAIN_FILE = featureFile(FEATURE, "main.md");

export interface BrainCommit {
  at: string;
  branch: string;
  summary: string;
  evidence?: string;
  updateRoadmap: boolean;
}

export interface BrainBranchMeta {
  name: string;
  purpose?: string;
  updatedAt: string;
  commits: number;
}

export interface BrainState {
  activeBranch: string;
  branches: Record<string, BrainBranchMeta>;
  sessions: Record<string, string>;
  lastCommit?: BrainCommit;
}

function branchKey(branch: string): string {
  return safeName(branch);
}

function branchFile(branch: string): string {
  return featureFile(FEATURE, `branches/${branchKey(branch)}.md`);
}

function ensureBranchDoc(branch: string, purpose?: string): string {
  const file = branchFile(branch);
  const existing = readText(file).trim();
  if (!existing) {
    writeText(file, `# ${branch}\n\n`);
  }

  if (purpose && !readText(file).includes("## Purpose")) {
    appendText(file, `## Purpose\n${purpose}\n\n`);
  }

  return file;
}

export function defaultBrainState(): BrainState {
  const now = new Date().toISOString();
  return {
    activeBranch: "main",
    branches: {
      main: {
        name: "main",
        updatedAt: now,
        commits: 0,
      },
    },
    sessions: {},
  };
}

export function loadBrainState(): BrainState {
  const loaded = readJson<BrainState>(STATE_FILE, defaultBrainState());
  const fallback = defaultBrainState();
  return {
    activeBranch: loaded.activeBranch || fallback.activeBranch,
    branches: loaded.branches && Object.keys(loaded.branches).length > 0 ? loaded.branches : fallback.branches,
    sessions: loaded.sessions ?? {},
    lastCommit: loaded.lastCommit,
  };
}

export function saveBrainState(state: BrainState): BrainState {
  writeJson(STATE_FILE, state);
  return state;
}

export function attachSession(state: BrainState, ctx: any): BrainState {
  const key = sessionKey(ctx);
  if (!key) return state;

  const current = state.sessions[key];
  if (current) {
    state.activeBranch = current;
  } else {
    state.sessions[key] = state.activeBranch;
  }

  return state;
}

export function setActiveBranch(state: BrainState, branch: string, ctx?: any, purpose?: string): BrainState {
  const now = new Date().toISOString();
  ensureBranchDoc(branch, purpose);
  const key = branchKey(branch);
  state.activeBranch = branch;
  state.branches[key] = {
    name: branch,
    purpose: purpose ?? state.branches[key]?.purpose,
    updatedAt: now,
    commits: state.branches[key]?.commits ?? 0,
  };

  if (ctx) {
    state.sessions[sessionKey(ctx)] = branch;
  }

  return state;
}

export function recordCommit(state: BrainState, commit: BrainCommit, ctx?: any): BrainState {
  const branch = commit.branch || state.activeBranch;
  ensureBranchDoc(branch);
  const file = branchFile(branch);
  const lines = [`## ${commit.at}`, `- summary: ${commit.summary}`];
  if (commit.evidence) lines.push(`- evidence: ${commit.evidence}`);
  if (commit.updateRoadmap) lines.push(`- roadmap: updated`);
  appendText(file, `\n${lines.join("\n")}\n`);

  if (commit.updateRoadmap) {
    appendText(MAIN_FILE, `- ${commit.at} ${branch}: ${truncate(commit.summary, 160)}\n`);
  }

  const key = branchKey(branch);
  state.activeBranch = branch;
  state.lastCommit = { ...commit, branch };
  state.branches[key] = {
    name: branch,
    purpose: state.branches[key]?.purpose,
    updatedAt: commit.at,
    commits: (state.branches[key]?.commits ?? 0) + 1,
  };

  if (ctx) {
    state.sessions[sessionKey(ctx)] = branch;
  }

  return state;
}

export function mergeBranch(state: BrainState, sourceBranch: string, targetBranch: string, synthesis?: string): BrainState {
  ensureBranchDoc(sourceBranch);
  ensureBranchDoc(targetBranch);
  const sourceText = readText(branchFile(sourceBranch)).trim();
  const targetFile = branchFile(targetBranch);
  const at = new Date().toISOString();
  const body = [
    `## Merge from ${sourceBranch}`,
    synthesis ? `- synthesis: ${synthesis}` : "- synthesis: merged branch notes",
    "",
    "```md",
    sourceText,
    "```",
  ].join("\n");

  appendText(targetFile, `\n${body}\n`);

  const key = branchKey(targetBranch);
  state.activeBranch = targetBranch;
  state.lastCommit = {
    at,
    branch: targetBranch,
    summary: `Merged ${sourceBranch}`,
    evidence: synthesis,
    updateRoadmap: false,
  };
  state.branches[key] = {
    name: targetBranch,
    purpose: state.branches[key]?.purpose,
    updatedAt: at,
    commits: (state.branches[key]?.commits ?? 0) + 1,
  };

  return state;
}

export function brainStatus(state: BrainState): string {
  const last = state.lastCommit ? truncate(state.lastCommit.summary, 80) : "no commits yet";
  return `Pi-Rogue Brain: ${state.activeBranch} · ${last}`;
}

export function brainPrompt(state: BrainState): string {
  const last = state.lastCommit
    ? `${state.lastCommit.branch}: ${truncate(state.lastCommit.summary, 120)}`
    : "none";

  return [
    "## Pi-Rogue Brain",
    `Active branch: ${state.activeBranch}`,
    `Last commit: ${last}`,
    `Tracked sessions: ${Object.keys(state.sessions).length}`,
    "Use memory_commit for meaningful checkpoints and cite context-mode evidence IDs instead of raw logs when possible.",
  ].join("\n");
}
