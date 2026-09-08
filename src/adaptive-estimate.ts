import { SIZE_ESTIMATES, type TaskSize } from "./types.js";

export interface EstimationRecord {
  size: TaskSize;
  actualTokens: number | null;
  model: string | null;
  result: string | null;
}

export interface AdaptiveEstimate {
  tokens: number;
  source: "task-override" | "history" | "static";
  samples: number;
}

function median(values: number[]): number {
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Learn a conservative estimate from successful completed runs of the same
 * size. Median resists one pathological run; a 15% safety margin prevents the
 * admission controller from treating the historical center as a hard cap.
 */
export function estimateTaskTokens(args: {
  size: TaskSize;
  overrideTokens?: number | null;
  records: EstimationRecord[];
  minSamples?: number;
}): AdaptiveEstimate {
  if (args.overrideTokens != null && args.overrideTokens > 0) {
    return { tokens: args.overrideTokens, source: "task-override", samples: 0 };
  }
  const minSamples = args.minSamples ?? 3;
  const samples = args.records
    .filter((r) => r.size === args.size && r.actualTokens != null && r.actualTokens > 0 && r.result !== "error")
    .map((r) => r.actualTokens as number);
  if (samples.length >= minSamples) {
    return {
      tokens: Math.ceil(median(samples) * 1.15),
      source: "history",
      samples: samples.length,
    };
  }
  return { tokens: SIZE_ESTIMATES[args.size].tokens, source: "static", samples: samples.length };
}
