import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoresearch, registerAutoresearchLab } from "./autoresearch.js";
import { registerGoal } from "./goal.js";
import { registerLoop } from "./loop.js";
import { registerNoveltyGuard } from "./novelty-guard.js";

export function registerOrchestration(pi: ExtensionAPI): void {
  registerNoveltyGuard(pi);
  registerGoal(pi);
  registerLoop(pi);
  registerAutoresearch(pi);
  registerAutoresearchLab(pi);
}

export { registerAutoresearch, registerAutoresearchLab, registerGoal, registerLoop };

export default function orchestrationExtension(pi: ExtensionAPI): void {
  registerOrchestration(pi);
}
