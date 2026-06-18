import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "@fiale-plus/pi-rogue-advisor";
import { registerOrchestration } from "@fiale-plus/pi-rogue-orchestration";
import { registerRouter } from "@fiale-plus/pi-rogue-router/extension";
import { registerFusion } from "@fiale-plus/pi-rogue-fusion/extension";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function contextBrokerEnabled(): boolean {
  return !DISABLED_VALUES.has(String(process.env.PI_CONTEXT_BROKER_ENABLED ?? "").trim().toLowerCase());
}

export async function registerBundle(pi: ExtensionAPI): Promise<void> {
  const p = pi as any;
  if (p.__piRogueBundleRegistered) return;
  p.__piRogueBundleRegistered = true;

  registerAdvisor(pi);
  registerRouter(pi);
  registerFusion(pi);
  registerOrchestration(pi);

  if (contextBrokerEnabled()) {
    try {
      const { registerContextBrokerBeta } = await import("@fiale-plus/pi-rogue-context-broker/extension");
      await registerContextBrokerBeta(pi, {
        durable: true,
        storeDir: join(homedir(), ".pi", "agent", "pi-rogue", "context-broker"),
      });
    } catch (error) {
      p.__piRogueContextBrokerError = error;
      console.warn("[pi-rogue] context broker registration failed; continuing without /pi-rogue-context", error);
    }
  }
}

export default function bundleExtension(pi: ExtensionAPI): Promise<void> {
  return registerBundle(pi);
}
