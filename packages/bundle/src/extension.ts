import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "@fiale-plus/pi-advisor";
import { registerBrain } from "@fiale-plus/pi-brain";
import { registerGoal } from "@fiale-plus/pi-goal";
import { registerGuardrails } from "@fiale-plus/pi-guardrails";
import { registerRepoArch } from "@fiale-plus/pi-repo-arch";

export function registerBundle(pi: ExtensionAPI): void {
  registerGuardrails(pi);
  registerAdvisor(pi);
  registerGoal(pi);
  registerRepoArch(pi);
  registerBrain(pi);
}

export default function bundleExtension(pi: ExtensionAPI): void {
  registerBundle(pi);
}
