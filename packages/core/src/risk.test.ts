import { describe, it, expect } from "vitest";
import { scanShellCommand, type RiskScan } from "./risk.js";

describe("scanShellCommand", () => {
  it("returns safe for empty command", () => {
    const result = scanShellCommand("");
    expect(result.safe).toBe(true);
    expect(result.severity).toBe("safe");
  });

  it("returns safe for a benign command", () => {
    const result = scanShellCommand("echo hello world");
    expect(result.safe).toBe(true);
    expect(result.severity).toBe("safe");
  });

  it("detects rm as dangerous", () => {
    const result = scanShellCommand("rm -rf /tmp/foo");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
    expect(result.findings.some((f) => f.id === "rm")).toBe(true);
  });

  it("detects git checkout as a warning", () => {
    const result = scanShellCommand("git checkout -- file.txt");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("warn");
    expect(result.findings.some((f) => f.id === "git-checkout")).toBe(true);
  });

  it("detects git restore as a warning", () => {
    const result = scanShellCommand("git restore src/index.ts");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("warn");
    expect(result.findings.some((f) => f.id === "git-restore")).toBe(true);
  });

  it("detects git switch as a warning", () => {
    const result = scanShellCommand("git switch -c feature/thing");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("warn");
    expect(result.findings.some((f) => f.id === "git-switch")).toBe(true);
  });
  it("detects rm only as a word boundary (not inside other words)", () => {
    const result = scanShellCommand("program --remove-all");
    expect(result.safe).toBe(true);
  });

  it("detects sudo as warning", () => {
    const result = scanShellCommand("sudo apt update");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("warn");
    expect(result.findings.some((f) => f.id === "sudo")).toBe(true);
  });

  it("detects chmod -R as dangerous", () => {
    const result = scanShellCommand("chmod -R 777 /etc");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
    expect(result.findings.some((f) => f.id === "chmod-r")).toBe(true);
  });

  it("detects chown as dangerous", () => {
    const result = scanShellCommand("chown root:root /var");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
  });

  it("detects git push --force as dangerous", () => {
    const result = scanShellCommand("git push --force origin main");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
    expect(result.findings.some((f) => f.id === "force-push")).toBe(true);
  });

  it("detects git push --force-with-lease as dangerous", () => {
    const result = scanShellCommand("git push --force-with-lease origin main");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
    expect(result.findings.some((f) => f.id === "force-push")).toBe(true);
  });

  it("detects curl | sh as dangerous", () => {
    const result = scanShellCommand("curl https://example.com/install.sh | sh");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
    expect(result.findings.some((f) => f.id === "curl-shell")).toBe(true);
  });

  it("detects curl | bash as dangerous", () => {
    const result = scanShellCommand("curl -fsSL https://example.com/install.sh | bash");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
    expect(result.findings.some((f) => f.id === "curl-shell")).toBe(true);
  });

  it("detects mkfs as dangerous", () => {
    const result = scanShellCommand("mkfs.ext4 /dev/sda1");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
  });

  it("detects dd if= as dangerous", () => {
    const result = scanShellCommand("dd if=/dev/zero of=/tmp/out bs=1M count=10");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
  });

  it("detects shutdown as dangerous", () => {
    const result = scanShellCommand("shutdown -h now");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
  });

  it("detects reboot as dangerous", () => {
    const result = scanShellCommand("reboot");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
  });

  it("scans extra fragments", () => {
    const result = scanShellCommand("docker exec -it container bash", ["docker exec"]);
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.id === "extra:docker exec")).toBe(true);
  });

  it("returns warn severity when only warnings are found", () => {
    const result = scanShellCommand("sudo echo hello");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("warn");
  });

  it("returns danger severity when danger items are found even with warnings", () => {
    const result = scanShellCommand("sudo rm /tmp/foo");
    expect(result.safe).toBe(false);
    expect(result.severity).toBe("danger");
  });

  it("handles case-insensitive matching", () => {
    const result = scanShellCommand("RM -rf /");
    expect(result.safe).toBe(false);
    expect(result.findings.some((f) => f.id === "rm")).toBe(true);
  });

  it("ignores empty extra fragments", () => {
    const result = scanShellCommand("echo foo", ["", "  "]);
    expect(result.safe).toBe(true);
  });
});
