#!/usr/bin/env node
// Enrich binary gate dataset with signal sources
// Usage: npx tsx scripts/enrich-binary-gate.ts [input] [output] [--signals=...]
// Signals: brief, intent, mode, depth, urgency, composite

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const INPUT = process.argv[2] || "data/routing/binary-gate.jsonl";
const OUTPUT = process.argv[3] || "data/routing/binary-gate-enriched.jsonl";
const SIGNALS = (process.argv.find(a => a.startsWith("--signals=")) || "--signals=intent,mode,urgency").replace("--signals=", "").split(",");

const RE = {
  plan: /\b(plan|design|architecture|scope|next step|strategy|proposal|should we|what should|tradeoff|decision|path forward|how to approach)\b/i,
  implement: /\b(implement|build|write|create|add|make|refactor|rename|extract|migrate|fix|patch)\b/i,
  review: /\b(review|check |verify|validate|look at|diff|pr |pull request|feedback)\b/i,
  debug: /\b(debug|bug|error|fail|broken|crash|stack|traceback|investigate|why (is|was|does|did|are) )/i,
  research: /\b(research|compare|difference|which (one|model|lib|is better)|how does|documentation|read (about|the)|what is)\b/i,
  ops: /\b(install|config|setup|run|build|deploy|ssh|status|stats|logs?|theme|terminal|shell|brew|npm|git)\b/i,
  handoff: /\b(continue|resume|compact|summarize|after compact|move on)\b/i,
};

function classifyIntent(t: string): string {
  t = " " + t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ") + " ";
  if (RE.plan.test(t)) return "plan"; if (RE.debug.test(t)) return "debug";
  if (RE.review.test(t)) return "review"; if (RE.research.test(t)) return "research";
  if (RE.implement.test(t)) return "implement"; if (RE.ops.test(t)) return "ops";
  if (RE.handoff.test(t)) return "handoff"; return "";
}

function classifyMode(t: string): string {
  t = t.trim();
  if (/^(create|add|make|change|write|fix|update|remove|delete|run|install|set[\s-]?up|build|deploy|check|investigate|debug|review|test|refactor|merge|close|open|start|stop|restart|continue|show|list|compact|setup)\b/i.test(t)) return "command";
  if (t.includes("?") || /^(what|why|how|when|where|who|which|is there|can we|should|does|did|are we|is it|do you|would you|could we)\b/i.test(t)) return "question";
  return "neutral";
}

function classifyUrgency(t: string): string {
  const lower = t.toLowerCase();
  const urgent = (lower.match(/\b(urgent|critical|blocked|stuck|important|asap|immediately|fast|soon|quick|hot|fire|p0|p1|deadline|panic|broken|crash|down|outage|emergency)\b/g) || []).length;
  const relaxed = (lower.match(/\b(optional|nice to have|eventually|later|someday|maybe|if time|no rush|take your time|relax|slow)\b/g) || []).length;
  if (urgent > relaxed) return "urgent";
  if (relaxed > urgent) return "relaxed";
  return "neutral";
}

if (!existsSync(INPUT)) { console.error("Input not found:", INPUT); process.exit(1); }

const rows = readFileSync(INPUT, "utf-8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const enriched: any[] = [];
const stats: Record<string, Record<string, number>> = {};

for (const r of rows) {
  const txt = r.text || "";
  const tags: string[] = [txt];
  tags.push("Brief: " + txt.slice(0, 120));

  for (const sig of SIGNALS) {
    let val = "";
    if (sig === "intent") val = classifyIntent(txt);
    else if (sig === "mode") val = classifyMode(txt);
    else if (sig === "urgency") val = classifyUrgency(txt);

    if (val) {
      const label = sig.charAt(0).toUpperCase() + sig.slice(1);
      tags.push(label + ": " + val);
      stats[sig] = stats[sig] || {};
      stats[sig][val] = (stats[sig][val] || 0) + 1;
    }
  }

  enriched.push({ ...r, text: tags.filter(Boolean).join(" ") });
}

for (const [sig, dist] of Object.entries(stats)) {
  console.error(`${sig} dist:`, JSON.stringify(dist));
}

writeFileSync(OUTPUT, enriched.map(r => JSON.stringify(r)).join("\n") + "\n");
console.error(`Wrote ${enriched.length} rows with signals [${SIGNALS.join(", ")}]`);
