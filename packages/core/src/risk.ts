export interface RiskFinding {
  id: string;
  label: string;
  severity: "warn" | "danger";
}

export interface RiskScan {
  safe: boolean;
  severity: "safe" | "warn" | "danger";
  findings: RiskFinding[];
  reason: string;
}

const DEFAULT_PATTERNS: RiskFinding[] = [
  { id: "rm", label: "rm", severity: "danger" },
  { id: "sudo", label: "sudo", severity: "warn" },
  { id: "chmod-r", label: "chmod -R", severity: "danger" },
  { id: "chown", label: "chown", severity: "danger" },
  { id: "mkfs", label: "mkfs", severity: "danger" },
  { id: "dd", label: "dd if=", severity: "danger" },
  { id: "shutdown", label: "shutdown", severity: "danger" },
  { id: "reboot", label: "reboot", severity: "danger" },
  { id: "force-push", label: "git push --force", severity: "danger" },
  { id: "curl-shell", label: "curl | sh", severity: "danger" },
  { id: "wget-shell", label: "wget | sh", severity: "danger" },
];

function contains(command: string, fragment: string): boolean {
  return command.toLowerCase().includes(fragment.toLowerCase());
}

export function scanShellCommand(command: string, extraFragments: string[] = []): RiskScan {
  const findings: RiskFinding[] = [];
  const text = command.trim();

  if (!text) {
    return { safe: true, severity: "safe", findings, reason: "Empty command." };
  }

  for (const pattern of DEFAULT_PATTERNS) {
    switch (pattern.id) {
      case "rm":
        if (/\brm\b/i.test(text)) findings.push(pattern);
        break;
      case "sudo":
        if (/\bsudo\b/i.test(text)) findings.push(pattern);
        break;
      case "chmod-r":
        if (/\bchmod\s+-R\b/i.test(text)) findings.push(pattern);
        break;
      case "chown":
        if (/\bchown\b/i.test(text)) findings.push(pattern);
        break;
      case "mkfs":
        if (/\bmkfs(?:\.[\w-]+)?\b/i.test(text)) findings.push(pattern);
        break;
      case "dd":
        if (/\bdd\s+if=/i.test(text)) findings.push(pattern);
        break;
      case "shutdown":
        if (/\bshutdown\b/i.test(text)) findings.push(pattern);
        break;
      case "reboot":
        if (/\breboot\b/i.test(text)) findings.push(pattern);
        break;
      case "force-push":
        if (/\bgit\s+push\b[\s\S]*--force(?:-with-lease)?/i.test(text)) findings.push(pattern);
        break;
      case "curl-shell":
        if (/\bcurl\b[\s\S]*\|\s*(sh|bash)\b/i.test(text)) findings.push(pattern);
        break;
      case "wget-shell":
        if (/\bwget\b[\s\S]*\|\s*(sh|bash)\b/i.test(text)) findings.push(pattern);
        break;
    }
  }

  for (const fragment of extraFragments) {
    if (!fragment.trim()) continue;
    if (contains(text, fragment)) {
      findings.push({ id: `extra:${fragment}`, label: fragment, severity: "danger" });
    }
  }

  if (findings.length === 0) {
    return { safe: true, severity: "safe", findings, reason: "No risky shell fragments found." };
  }

  const severity = findings.some((finding) => finding.severity === "danger") ? "danger" : "warn";
  const labels = findings.map((finding) => finding.label).join(", ");
  return {
    safe: false,
    severity,
    findings,
    reason: `Detected risky shell fragment(s): ${labels}`,
  };
}
