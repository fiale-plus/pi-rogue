import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAdvisor } from "@fiale-plus/pi-rogue-advisor";

export async function registerBundle(pi: ExtensionAPI): Promise<void> {
  const state = pi as unknown as { __piRogueBundleRegistered?: boolean };
  if (state.__piRogueBundleRegistered) return;
  state.__piRogueBundleRegistered = true;

  registerAdvisor(pi);
}

export default function bundleExtension(pi: ExtensionAPI): Promise<void> {
  return registerBundle(pi);
}
