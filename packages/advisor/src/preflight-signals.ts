/** Lightweight intent classifier for preflight signal enrichment */
export function classifyIntent(text: string): string {
  const t = ` ${String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  if (/\b(plan|design|architecture|scope|next step|strategy|proposal|should we|what should|tradeoff|decision|path forward|how to approach)\b/.test(t)) return "plan";
  if (/\b(debug|bug|error|fail|broken|crash|stack|traceback|investigate|why (is|was|does|did|are) )/.test(t)) return "debug";
  if (/\b(review|check |verify|validate|look at|diff|pr |pull request|feedback)\b/i.test(t)) return "review";
  if (/\b(research|compare|difference|which (one|model|lib|is better)|how does|documentation|read (about|the)|what is)\b/i.test(t)) return "research";
  if (/\b(implement|build|write|create|add|make|refactor|rename|extract|migrate|fix|patch)\b/i.test(t)) return "implement";
  if (/\b(install|config|setup|run|build|deploy|ssh|status|stats|logs?|theme|terminal|shell|brew|npm|git)\b/i.test(t)) return "ops";
  if (/\b(continue|resume|compact|summarize|after compact|move on)\b/i.test(t)) return "handoff";
  return "";
}

/** Classify prompt as question/command/neutral for signal enrichment */
export function classifyMode(text: string): string {
  const t = String(text ?? "").trim();
  if (!t) return "";
  if (/^(create|add|make|change|write|fix|update|remove|delete|run|install|set[\s-]?up|build|deploy|check|investigate|debug|review|test|refactor|merge|close|open|start|stop|restart|continue|show|list|compact|setup)\b/i.test(t)) return "command";
  if (t.includes("?") || /^(what|why|how|when|where|who|which|is there|can we|should|does|did|are we|is it|do you|would you|could we)\b/i.test(t)) return "question";
  return "neutral";
}
