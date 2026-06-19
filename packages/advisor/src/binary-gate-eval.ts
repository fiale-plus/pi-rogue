// Pure, side-effect-free evaluation helpers for the advisor binary gate.
// Shared by training (`scripts/train-binary-gate.ts`), source/file eval scripts,
// and unit tests. Nothing here reads files or mutates state.

export type BinaryLabel = "continue" | "escalate";

/** Cost-weighted loss = (fnCost·FN + fpCost·FP) / N, in [0, max(fnCost,fpCost)]. */
export function costWeightedLoss(
  tp: number,
  fp: number,
  fn: number,
  tn: number,
  fnCost: number,
  fpCost: number,
): number {
  const n = tp + fp + fn + tn;
  if (n === 0) return 0;
  return (fnCost * fn + fpCost * fp) / n;
}

/** Brier score for the escalate class. Lower is better; 0 = perfect. */
export function brierScore(probabilities: number[], labels: BinaryLabel[]): number {
  if (probabilities.length === 0) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const obs = labels[i] === "escalate" ? 1 : 0;
    const p = clamp01(probabilities[i]);
    sum += (p - obs) ** 2;
    n++;
  }
  return n ? sum / n : 0;
}

/** Expected Calibration Error over equal-width probability bins. Lower is better. */
export function expectedCalibrationError(
  probabilities: number[],
  labels: BinaryLabel[],
  bins = 10,
): number {
  if (probabilities.length === 0 || bins <= 0) return 0;
  const edges: number[] = [];
  for (let b = 0; b <= bins; b++) edges.push(b / bins);
  const bucket: Array<{ sum: number; count: number; acc: number }> = Array.from({ length: bins }, () => ({ sum: 0, count: 0, acc: 0 }));
  for (let i = 0; i < probabilities.length; i++) {
    const p = clamp01(probabilities[i]);
    let idx = Math.floor(p * bins);
    if (idx >= bins) idx = bins - 1;
    bucket[idx].sum += p;
    bucket[idx].count += 1;
    bucket[idx].acc += labels[i] === "escalate" ? 1 : 0;
  }
  let ece = 0;
  const n = probabilities.length;
  for (const b of bucket) {
    if (b.count === 0) continue;
    const avgConf = b.sum / b.count;
    const avgAcc = b.acc / b.count;
    ece += (b.count / n) * Math.abs(avgConf - avgAcc);
  }
  return ece;
}

export interface PlattCalibration {
  method: "platt";
  /** P(escalate) = sigmoid(a * logit + b). Identity calibration is a=1, b=0. */
  a: number;
  b: number;
}

export type Calibration = PlattCalibration | { method: "none" };

/**
 * Fit Platt scaling on (logit, label) pairs via gradient descent.
 * `logits` are the uncalibrated escalate logits (s_escalate - s_continue).
 * Returns identity calibration {a:1, b:0} if the input is degenerate.
 */
export function fitPlattCalibration(logits: number[], labels: BinaryLabel[], options?: { lr?: number; epochs?: number; l2?: number }): PlattCalibration {
  const n = logits.length;
  if (n === 0) return { method: "platt", a: 1, b: 0 };
  const lr = options?.lr ?? 0.5;
  const epochs = options?.epochs ?? 200;
  const l2 = options?.l2 ?? 0.01;
  let a = 0;
  let b = 0;
  const y = labels.map((label) => (label === "escalate" ? 1 : 0));
  for (let ep = 0; ep < epochs; ep++) {
    let ga = 0;
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = a * logits[i] + b;
      const p = sigmoid(z);
      const err = p - y[i];
      ga += err * logits[i];
      gb += err;
    }
    a -= lr * (ga / n + l2 * a);
    b -= lr * (gb / n);
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { method: "platt", a: 1, b: 0 };
  return { method: "platt", a, b };
}

/** Apply calibration to an uncalibrated escalate logit. */
export function applyCalibration(logit: number, calibration: Calibration | undefined): number {
  if (!calibration || calibration.method === "none") return sigmoid(logit);
  return sigmoid(calibration.a * logit + calibration.b);
}

function confusionAt(probabilities: number[], labels: BinaryLabel[], threshold: number): { tp: number; fp: number; fn: number; tn: number } {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const predEscalate = probabilities[i] >= threshold;
    const actualEscalate = labels[i] === "escalate";
    if (actualEscalate && predEscalate) tp++;
    else if (actualEscalate && !predEscalate) fn++;
    else if (!actualEscalate && predEscalate) fp++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

/** Sweep operating thresholds on a cost-weighted objective. Returns the best threshold. */
export function sweepThreshold(
  probabilities: number[],
  labels: BinaryLabel[],
  fnCost: number,
  fpCost: number,
  options?: { steps?: number; min?: number; max?: number },
): { threshold: number; costWeightedLoss: number } {
  const steps = options?.steps ?? 101;
  const lo = options?.min ?? 0;
  const hi = options?.max ?? 1;
  let best = { threshold: 0.5, costWeightedLoss: Infinity };
  for (let s = 0; s <= steps; s++) {
    const threshold = lo + (hi - lo) * (s / steps);
    const { tp, fp, fn, tn } = confusionAt(probabilities, labels, threshold);
    const loss = costWeightedLoss(tp, fp, fn, tn, fnCost, fpCost);
    if (loss < best.costWeightedLoss) best = { threshold, costWeightedLoss: loss };
  }
  return best;
}

export interface ConstrainedThresholdResult {
  threshold: number;
  costWeightedLoss: number;
  accuracy: number;
  escalationRate: number;
  feasible: boolean;
  guardSlices: GuardSliceResult[];
}

export function selectConstrainedThreshold(
  rows: Array<{ text: string; label: BinaryLabel }>,
  probabilities: number[],
  fnCost: number,
  fpCost: number,
  options?: {
    steps?: number;
    min?: number;
    max?: number;
    minAccuracy?: number;
    maxEscalationRate?: number;
    guardFloors?: Partial<Record<GuardSlice, number>>;
    minGuardSupport?: number;
  },
): ConstrainedThresholdResult {
  const labels = rows.map((row) => row.label);
  const steps = options?.steps ?? 101;
  const lo = options?.min ?? 0;
  const hi = options?.max ?? 1;
  const minAccuracy = options?.minAccuracy ?? 0;
  const maxEscalationRate = options?.maxEscalationRate ?? 1;
  const guardFloors = options?.guardFloors ?? {};
  const minGuardSupport = options?.minGuardSupport ?? 5;
  let best: ConstrainedThresholdResult | null = null;
  let bestUnconstrained: ConstrainedThresholdResult | null = null;
  for (let s = 0; s <= steps; s++) {
    const threshold = lo + (hi - lo) * (s / steps);
    const { tp, fp, fn, tn } = confusionAt(probabilities, labels, threshold);
    const total = tp + fp + fn + tn || 1;
    const result: ConstrainedThresholdResult = {
      threshold,
      costWeightedLoss: costWeightedLoss(tp, fp, fn, tn, fnCost, fpCost),
      accuracy: (tp + tn) / total,
      escalationRate: (tp + fp) / total,
      feasible: false,
      guardSlices: guardSliceRecall(rows, probabilities, threshold, guardFloors),
    };
    if (!bestUnconstrained || result.costWeightedLoss < bestUnconstrained.costWeightedLoss) bestUnconstrained = result;
    const guardsPass = result.guardSlices.every((slice) => slice.support < minGuardSupport || slice.passed);
    const feasible = result.accuracy >= minAccuracy && result.escalationRate <= maxEscalationRate && guardsPass;
    if (!feasible) continue;
    result.feasible = true;
    if (!best || result.costWeightedLoss < best.costWeightedLoss) best = result;
  }
  return best ?? { ...bestUnconstrained!, feasible: false };
}

// ── Guard slices ─────────────────────────────────────────────────────────
// A row may belong to multiple slices. Used to enforce recall floors before
// a candidate model is promotable. Keep keyword lists aligned with the cue
// lists in binary-gate-features.ts.

export type GuardSlice = "safety" | "stuck" | "debug";

const SLICE_KEYWORDS: Record<GuardSlice, string[]> = {
  safety: [
    "rm -rf", "sudo", "shutdown", "reboot", "mkfs", "chmod -r", "chown",
    "git push --force", "curl | sh", "wget | sh", "drop table", "delete database",
    "secret", "token", "credential", "password", "prod", "production", "deploy", "deploying",
  ],
  stuck: [
    "stuck", "looping", "spinning", "no progress", "no concrete progress",
    "same failure", "repeated failure", "repeated planning", "self talk",
    "forever thinking", "alternative action", "blocked",
  ],
  debug: [
    "debug", "bug", "error", "stack trace", "traceback", "fail", "broken",
    "investigate", "why is", "cannot", "can't", "crash", "regression",
  ],
};

export function sliceMembership(text: string): Set<GuardSlice> {
  const lower = String(text ?? "").toLowerCase();
  const members = new Set<GuardSlice>();
  (Object.keys(SLICE_KEYWORDS) as GuardSlice[]).forEach((slice) => {
    for (const kw of SLICE_KEYWORDS[slice]) {
      if (lower.includes(kw)) {
        members.add(slice);
        break;
      }
    }
  });
  return members;
}

export interface GuardSliceResult {
  slice: GuardSlice;
  support: number;
  escalateRecall: number;
  passed: boolean;
}

export function guardSliceRecall(
  rows: Array<{ text: string; label: BinaryLabel }>,
  probabilities: number[],
  threshold: number,
  floors: Partial<Record<GuardSlice, number>>,
): GuardSliceResult[] {
  const bySlice: Record<GuardSlice, { tp: number; fn: number; support: number }> = {
    safety: { tp: 0, fn: 0, support: 0 },
    stuck: { tp: 0, fn: 0, support: 0 },
    debug: { tp: 0, fn: 0, support: 0 },
  };
  for (let i = 0; i < rows.length; i++) {
    const members = sliceMembership(rows[i].text);
    const actualEscalate = rows[i].label === "escalate";
    const predEscalate = probabilities[i] >= threshold;
    members.forEach((slice) => {
      if (actualEscalate) {
        bySlice[slice].support++;
        if (predEscalate) bySlice[slice].tp++;
        else bySlice[slice].fn++;
      }
    });
  }
  return (Object.keys(bySlice) as GuardSlice[]).map((slice) => {
    const { tp, fn, support } = bySlice[slice];
    const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
    const floor = floors[slice] ?? 0;
    return { slice, support, escalateRecall: recall, passed: support === 0 || recall >= floor };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

export function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

export function clamp01(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
