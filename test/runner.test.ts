import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs, parseResultJson, runClaudeTask, type ExecFn } from "../src/runner.js";
import type { Task } from "../src/types.js";

// Real captured `claude -p --output-format json` output (2026-06-11), not hand-written.
const FIXTURE = readFileSync(
  join(import.meta.dirname, "fixtures", "claude-result-success.json"), "utf8",
);

function task(partial: Partial<Task>): Task {
  return {
    id: 1, createdTs: 0, updatedTs: 0, prompt: "do something", cwd: "/tmp",
    size: "xs", priority: 0, deferOk: true, permissionClass: "read-only",
    permissionMode: "default", unattendedOk: true, scheduledWindow: "night",
    status: "running", attempts: 1, resumeSessionId: null, worktreePath: null,
    lastError: null,
    ...partial,
  };
}

describe("parseResultJson", () => {
  it("extracts tokens, cost, model, session from the real fixture", () => {
    const a = parseResultJson(FIXTURE);
    expect(a.result).toBe("success");
    expect(a.inputTokens).toBe(12596);
    expect(a.outputTokens).toBe(4);
    expect(a.cacheCreationTokens).toBe(19636);
    expect(a.cacheReadTokens).toBe(0);
    expect(a.totalCostUsd).toBeCloseTo(0.25944);
    expect(a.durationMs).toBe(6095);
    expect(a.sessionId).toBe("628741d8-0c94-4db7-b2c2-69b5cf780d75");
    expect(a.model).toBe("claude-opus-4-8[1m]");
    expect(a.error).toBeNull();
    expect(a.rawJson).toBe(FIXTURE.trim());
  });

  it("keeps raw output and reports error on unparseable stdout", () => {
    const a = parseResultJson("not json at all");
    expect(a.result).toBe("error");
    expect(a.error).toContain("unparseable");
    expect(a.rawJson).toBe("not json at all");
    expect(a.inputTokens).toBeNull();
  });

  it("flags is_error result payloads", () => {
    const a = parseResultJson(JSON.stringify({
      type: "result", subtype: "error_max_turns", is_error: true, result: "hit max turns",
    }));
    expect(a.result).toBe("error_max_turns");
    expect(a.error).toContain("hit max turns");
  });
});

describe("buildClaudeArgs", () => {
  it("read-only uses a fixed read-only tool allowlist, not a permission mode", () => {
    const args = buildClaudeArgs(task({ permissionClass: "read-only" }));
    expect(args).toContain("--allowedTools");
    expect(args).not.toContain("--permission-mode");
    expect(args.join(" ")).toContain("--output-format json");
  });

  it("write-scoped passes the confirmed permission mode", () => {
    const args = buildClaudeArgs(
      task({ permissionClass: "write-scoped", permissionMode: "acceptEdits" }),
    );
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
  });
});

describe("runClaudeTask (injected exec — no real claude)", () => {
  it("returns success with actuals from canned stdout", async () => {
    const fake: ExecFn = async () => ({ stdout: FIXTURE, stderr: "", exitCode: 0 });
    const { actuals, success } = await runClaudeTask(task({}), "/tmp", 60_000, { exec: fake });
    expect(success).toBe(true);
    expect(actuals.inputTokens).toBe(12596);
  });

  it("fails on nonzero exit with stderr captured", async () => {
    const fake: ExecFn = async () => ({ stdout: "", stderr: "boom", exitCode: 2 });
    const { actuals, success } = await runClaudeTask(task({}), "/tmp", 60_000, { exec: fake });
    expect(success).toBe(false);
    expect(actuals.result).toBe("error");
    expect(actuals.error).toContain("boom");
  });

  it("marks timed-out runs distinctly", async () => {
    const fake: ExecFn = async () => ({ stdout: "", stderr: "", exitCode: 1, timedOut: true });
    const { actuals, success } = await runClaudeTask(task({}), "/tmp", 300_000, { exec: fake });
    expect(success).toBe(false);
    expect(actuals.result).toBe("timeout");
    expect(actuals.error).toContain("timed out after 5m");
  });

  it("treats permission denials as not-success (work likely incomplete)", async () => {
    const withDenials = JSON.stringify({
      ...JSON.parse(FIXTURE),
      permission_denials: [{ tool_name: "Bash" }],
    });
    const fake: ExecFn = async () => ({ stdout: withDenials, stderr: "", exitCode: 0 });
    const { actuals, success } = await runClaudeTask(task({}), "/tmp", 60_000, { exec: fake });
    expect(success).toBe(false);
    expect(actuals.error).toContain("permission denial");
    expect(actuals.inputTokens).toBe(12596); // actuals still recorded
  });
});

describe("realExec timeout (real child process, no claude)", () => {
  it("kills an overrunning child and reports timedOut", async () => {
    const { realExec } = await import("../src/runner.js");
    const start = Date.now();
    const r = await realExec(
      process.execPath, ["-e", "setTimeout(()=>{}, 60000)"],
      { cwd: "/tmp", timeoutMs: 300 },
    );
    expect(Date.now() - start).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });
});
