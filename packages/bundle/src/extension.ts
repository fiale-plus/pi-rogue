import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "@fiale-plus/pi-rogue-advisor";
import { registerOrchestration } from "@fiale-plus/pi-rogue-orchestration";

const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

function contextBrokerEnabled(): boolean {
  return !DISABLED_VALUES.has(String(process.env.PI_CONTEXT_BROKER_ENABLED ?? "").trim().toLowerCase());
}

export async function registerBundle(pi: ExtensionAPI): Promise<void> {
  const p = pi as any;
  if (p.__piRogueBundleRegistered) return;
  p.__piRogueBundleRegistered = true;

  if (contextBrokerEnabled()) {
    const { registerContextBrokerBeta } = await import("@fiale-plus/pi-rogue-context-broker/extension");
    await registerContextBrokerBeta(pi);
  }

  registerAdvisor(pi);
  registerOrchestration(pi);
}

export default function bundleExtension(pi: ExtensionAPI): Promise<void> {
  return registerBundle(pi);
}
