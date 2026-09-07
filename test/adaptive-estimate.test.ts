import { describe, expect, it } from "vitest";
import { estimateTaskTokens } from "../src/adaptive-estimate.js";

describe("adaptive token estimation", () => {
  it("uses static estimate before enough samples exist", () => {
    const r = estimateTaskTokens({
      size: "m",
      records: [{ size: "m", actualTokens: 50_000, model: "sonnet", result: "success" }],
      minSamples: 3,
    });
    expect(r.source).toBe("static");
    expect(r.tokens).toBe(60_000);
  });

  it("uses median history plus safety margin after enough samples", () => {
    const r = estimateTaskTokens({
      size: "m",
      records: [
        { size: "m", actualTokens: 40_000, model: "sonnet", result: "success" },
        { size: "m", actualTokens: 50_000, model: "sonnet", result: "success" },
        { size: "m", actualTokens: 200_000, model: "sonnet", result: "success" },
      ],
      minSamples: 3,
    });
    expect(r.source).toBe("history");
    expect(r.tokens).toBe(57_500);
  });

  it("task override takes precedence", () => {
    const r = estimateTaskTokens({ size: "xl", overrideTokens: 123_456, records: [] });
    expect(r).toEqual({ tokens: 123_456, source: "task-override", samples: 0 });
  });
});
