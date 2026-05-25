import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "@fiale-plus/pi-rogue-advisor";
import { registerBrain } from "@fiale-plus/pi-brain";
import { registerOrchestration } from "@fiale-plus/pi-rogue-orchestration";
import { registerGuardrails } from "@fiale-plus/pi-guardrails";
import { registerRepoArch } from "@fiale-plus/pi-repo-arch";

export function registerBundle(pi: ExtensionAPI): void {
  registerGuardrails(pi);
  registerAdvisor(pi);
  registerOrchestration(pi);
  registerRepoArch(pi);
  registerBrain(pi);
}

export default function bundleExtension(pi: ExtensionAPI): void {
  registerBundle(pi);
}
