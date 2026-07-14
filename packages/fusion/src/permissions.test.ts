import { chmodSync, lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFusionRecipes } from "./recipe.js";
import { createFileFusionTraceStore } from "./runner.js";

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("Fusion artifact permissions", () => {
  it("creates and tightens traces as owner-only under a permissive umask", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-trace-permissions-"));
    const dir = join(root, "traces");
    const previous = process.umask(0o022);
    try {
      const store = createFileFusionTraceStore(dir);
      const path = store.write({ status: "ok", recipe_id: "synthetic", run_id: "run-1", responses: [], failed_models: [], requested_params: {}, effective_params: {} } as any)!;
      expect(mode(dir)).toBe(0o700);
      expect(mode(path)).toBe(0o600);

      chmodSync(dir, 0o755);
      chmodSync(path, 0o644);
      store.write({ status: "ok", recipe_id: "synthetic", run_id: "run-1", responses: [], failed_models: [], requested_params: {}, effective_params: {} } as any);
      expect(mode(dir)).toBe(0o700);
      expect(mode(path)).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it("tightens existing recipe state during ordinary loading", () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-recipe-permissions-"));
    const path = join(root, "recipes.json");
    writeFileSync(path, JSON.stringify({ recipes: [] }), { mode: 0o644 });
    chmodSync(root, 0o755);

    const loaded = loadFusionRecipes(root, { ...process.env, PI_ROGUE_FUSION_RECIPES: path });

    expect(loaded.errors).toEqual([]);
    expect(mode(root)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });
});
