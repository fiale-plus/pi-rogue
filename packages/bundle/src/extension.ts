import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "@fiale-plus/pi-rogue-advisor";
import { registerOrchestration } from "@fiale-plus/pi-rogue-orchestration";
import { registerRouter } from "@fiale-plus/pi-rogue-router/extension";
import { registerDefaultContextBroker } from "./context-broker-default.js";
import { createHarmonizationStatusCatalog } from "./status-catalog.js";

export async function registerBundle(pi: ExtensionAPI): Promise<void> {
  const p = pi as any;
  if (p.__piRogueBundleRegistered) return;
  p.__piRogueBundleRegistered = true;

  registerAdvisor(pi);
  registerRouter(pi);
  registerOrchestration(pi);

  await registerDefaultContextBroker(pi);
  p.__piRogueFeatureStatusCatalog = (ctx: unknown) => createHarmonizationStatusCatalog(ctx, {
    contextBroker: () => p.__piRogueContextBrokerStatus ?? { enabled: false, registered: false },
  });
}

export default function bundleExtension(pi: ExtensionAPI): Promise<void> {
  return registerBundle(pi);
}
