import { createHash } from "node:crypto";
import fs from "node:fs";

export type BinaryDatasetManifest = {
  schemaVersion: 1;
  datasetSha256: string;
  mode: "reviewed-training" | "weak-label-research";
  promotable: boolean;
  minimumReviewed: number;
  counts: {
    total: number;
    reviewed: number;
    heuristic: number;
    conflicts: number;
    exclusions: Record<string, number>;
    sources: Record<string, number>;
  };
};

export function manifestPathFor(datasetPath: string): string {
  return `${datasetPath}.manifest.json`;
}

export function datasetSha256(datasetPath: string): string {
  return createHash("sha256").update(fs.readFileSync(datasetPath)).digest("hex");
}

export function readBinaryDatasetManifest(datasetPath: string): BinaryDatasetManifest {
  const manifestPath = manifestPathFor(datasetPath);
  if (!fs.existsSync(manifestPath)) throw new Error(`Binary dataset manifest is required: ${manifestPath}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { throw new Error(`Binary dataset manifest is invalid: ${manifestPath}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Binary dataset manifest is invalid: ${manifestPath}`);
  const manifest = value as BinaryDatasetManifest;
  if (manifest.schemaVersion !== 1 || !manifest.counts || typeof manifest.datasetSha256 !== "string") {
    throw new Error(`Binary dataset manifest schema is unsupported: ${manifestPath}`);
  }
  if (datasetSha256(datasetPath) !== manifest.datasetSha256) throw new Error(`Binary dataset digest does not match manifest: ${datasetPath}`);
  if (!Number.isInteger(manifest.minimumReviewed) || manifest.minimumReviewed < 1) throw new Error(`Binary dataset manifest reviewed minimum is invalid: ${manifestPath}`);
  const rows = fs.readFileSync(datasetPath, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as { provenance?: unknown });
  const reviewed = rows.filter((row) => row.provenance === "reviewed").length;
  const heuristic = rows.filter((row) => row.provenance === "heuristic").length;
  if (rows.length !== manifest.counts.total || reviewed !== manifest.counts.reviewed || heuristic !== manifest.counts.heuristic || reviewed + heuristic !== rows.length) {
    throw new Error(`Binary dataset provenance counts do not match manifest: ${datasetPath}`);
  }
  const shouldPromote = reviewed >= manifest.minimumReviewed;
  if (manifest.promotable !== shouldPromote || manifest.mode !== (shouldPromote ? "reviewed-training" : "weak-label-research")) {
    throw new Error(`Binary dataset manifest mode conflicts with reviewed provenance: ${manifestPath}`);
  }
  return manifest;
}

export function assertDatasetGovernance(datasetPath: string, allowWeakLabelResearch: boolean): BinaryDatasetManifest {
  const manifest = readBinaryDatasetManifest(datasetPath);
  const weak = manifest.mode === "weak-label-research" || !manifest.promotable || manifest.counts.reviewed < manifest.minimumReviewed;
  if (weak && !allowWeakLabelResearch) {
    throw new Error(`Binary dataset is weak-label research only (${manifest.counts.reviewed}/${manifest.minimumReviewed} reviewed); pass --allow-weak-label-research for non-promotable research.`);
  }
  return manifest;
}
