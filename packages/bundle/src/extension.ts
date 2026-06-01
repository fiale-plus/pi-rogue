import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "@fiale-plus/pi-rogue-advisor";
import { registerOrchestration } from "@fiale-plus/pi-rogue-orchestration";

export function registerBundle(pi: ExtensionAPI): void {
  const p = pi as any;
  if (p.__piRogueBundleRegistered) return;
  p.__piRogueBundleRegistered = true;

  registerAdvisor(pi);
  registerOrchestration(pi);
}

export default function bundleExtension(pi: ExtensionAPI): void {
  registerBundle(pi);
}
