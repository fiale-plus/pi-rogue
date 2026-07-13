import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOST_RANGE = ">=0.80.6 <0.81.0";
const NODE_RANGE = ">=22.19.0";
const peerManifests = [
  "packages/advisor/package.json",
  "packages/bundle/package.json",
  "packages/fusion/package.json",
  "packages/lab/brain/package.json",
  "packages/lab/guardrails/package.json",
  "packages/lab/repo-arch/package.json",
  "packages/orchestration/package.json",
  "packages/router/package.json",
];

function manifest(path: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8"));
}

describe("supported Pi host", () => {
  it("keeps public and vendored peer floors aligned with the tested host", () => {
    for (const path of peerManifests) {
      expect(manifest(path).peerDependencies?.["@earendil-works/pi-coding-agent"], path).toBe(HOST_RANGE);
    }
    const advisor = manifest("packages/advisor/package.json");
    expect(advisor.peerDependencies["@earendil-works/pi-ai"]).toBe(HOST_RANGE);
    expect(advisor.peerDependencies["@earendil-works/pi-tui"]).toBe(HOST_RANGE);
  });

  it("locks the tested host and its Node floor", () => {
    const root = manifest("package.json");
    const bundle = manifest("packages/bundle/package.json");
    const lock = manifest("package-lock.json");
    expect(root.devDependencies["@earendil-works/pi-coding-agent"]).toBe("0.80.6");
    expect(lock.packages["node_modules/@earendil-works/pi-coding-agent"].version).toBe("0.80.6");
    expect(root.engines.node).toBe(NODE_RANGE);
    expect(bundle.engines.node).toBe(NODE_RANGE);
  });
});
