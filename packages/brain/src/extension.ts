import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncate } from "@fiale-plus/pi-core";
import {
  attachSession,
  brainPrompt,
  brainStatus,
  loadBrainState,
  mergeBranch,
  recordCommit,
  saveBrainState,
  setActiveBranch,
  type BrainState,
} from "./store.js";

function textResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

function commitDescription(state: BrainState): string {
  return brainStatus(state);
}

function contextBrokerBrief(pi: ExtensionAPI): string {
  try {
    const text = (pi as any).__piRogueContextBroker?.renderBrief?.();
    return typeof text === "string" && text.includes("ctx://") ? text.slice(0, 2400) : "";
  } catch {
    return "";
  }
}

export function registerBrain(pi: ExtensionAPI): void {
  let state = loadBrainState();

  const syncStatus = (ctx: any) => {
    ctx.ui.setStatus("brain", commitDescription(state));
  };

  pi.on("session_start", (_event, ctx) => {
    state = attachSession(state, ctx);
    saveBrainState(state);
    syncStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    saveBrainState(state);
  });

  pi.on("before_agent_start", (event, ctx) => {
    state = attachSession(state, ctx);
    saveBrainState(state);
    syncStatus(ctx);

    const brokerBrief = contextBrokerBrief(pi);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${brainPrompt(state)}${brokerBrief ? `\n\nContext broker brief (lookup-first):\n${brokerBrief}` : ""}`,
    };
  });

  pi.registerCommand("brain", {
    description: "Show the current brain status",
    handler: async (_args, ctx) => {
      state = attachSession(state, ctx);
      saveBrainState(state);
      ctx.ui.notify(commitDescription(state), "info");
    },
  });

  pi.registerTool({
    name: "memory_commit",
    label: "Memory Commit",
    description: "Checkpoint a milestone in local memory.",
    parameters: Type.Object({
      summary: Type.String({ description: "Short summary of this checkpoint" }),
      update_roadmap: Type.Optional(Type.Boolean({ description: "Update the lightweight roadmap file" })),
      evidence: Type.Optional(Type.String({ description: "Optional context-mode evidence or citation" })),
      branch: Type.Optional(Type.String({ description: "Optional target branch" })),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state = attachSession(state, ctx);
      const branchInput = (params as { branch?: unknown }).branch;
      const branch = String(branchInput ?? state.activeBranch ?? "main").trim() || "main";
      const summary = String((params as { summary?: unknown }).summary ?? "").trim();
      const evidence = String((params as { evidence?: unknown }).evidence ?? "").trim();
      const updateRoadmap = (params as { update_roadmap?: unknown }).update_roadmap !== false;

      if (!summary) {
        return Promise.resolve(textResult("memory_commit requires a summary."));
      }

      state = recordCommit(
        state,
        {
          at: new Date().toISOString(),
          branch,
          summary,
          evidence: evidence || undefined,
          updateRoadmap,
        },
        ctx,
      );
      saveBrainState(state);
      syncStatus(ctx);

      return Promise.resolve(textResult(`Committed ${branch}: ${truncate(summary, 120)}`));
    },
  });

  pi.registerTool({
    name: "memory_branch",
    label: "Memory Branch",
    description: "Create, switch, or merge a memory branch.",
    parameters: Type.Object({
      action: Type.String({ enum: ["create", "switch", "merge"] }),
      name: Type.Optional(Type.String({ description: "New branch name" })),
      purpose: Type.Optional(Type.String({ description: "Why this branch exists" })),
      branch: Type.Optional(Type.String({ description: "Branch to switch to or merge from" })),
      synthesis: Type.Optional(Type.String({ description: "Optional merge synthesis" })),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state = attachSession(state, ctx);
      const action = String((params as { action?: unknown }).action ?? "");
      const name = String((params as { name?: unknown }).name ?? "").trim();
      const purpose = String((params as { purpose?: unknown }).purpose ?? "").trim();
      const branch = String((params as { branch?: unknown }).branch ?? "").trim();
      const synthesis = String((params as { synthesis?: unknown }).synthesis ?? "").trim();

      if (action === "create") {
        if (!name) {
          return Promise.resolve(textResult("memory_branch create requires a name."));
        }
        state = setActiveBranch(state, name, ctx, purpose || undefined);
        saveBrainState(state);
        syncStatus(ctx);
        return Promise.resolve(textResult(`Created and switched to branch ${name}.`));
      }

      if (action === "switch") {
        if (!branch) {
          return Promise.resolve(textResult("memory_branch switch requires branch."));
        }
        state = setActiveBranch(state, branch, ctx);
        saveBrainState(state);
        syncStatus(ctx);
        return Promise.resolve(textResult(`Switched to branch ${branch}.`));
      }

      if (action === "merge") {
        if (!branch) {
          return Promise.resolve(textResult("memory_branch merge requires branch."));
        }
        const target = state.activeBranch || "main";
        state = mergeBranch(state, branch, target, synthesis || undefined);
        saveBrainState(state);
        syncStatus(ctx);
        return Promise.resolve(textResult(`Merged ${branch} into ${target}.`));
      }

      return Promise.resolve(textResult("Unknown memory_branch action."));
    },
  });
}

export default function brainExtension(pi: ExtensionAPI): void {
  registerBrain(pi);
}
