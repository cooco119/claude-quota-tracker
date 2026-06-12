import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestUsage, parseUsageLine } from "../src/ingest.js";
import { Store } from "../src/store.js";

const dirs: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "qt-ingest-"));
  dirs.push(root);
  mkdirSync(join(root, "proj"), { recursive: true });
  return root;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A valid assistant+usage jsonl line. */
function line(id: string, opts: Partial<{
  input: number; output: number; cacheCreate: number; cacheRead: number;
  model: string; ts: string; sidechain: boolean; type: string;
}> = {}): string {
  return JSON.stringify({
    type: opts.type ?? "assistant",
    requestId: "req_" + id,
    timestamp: opts.ts ?? "2026-06-12T03:00:00.000Z",
    sessionId: "sess-1",
    cwd: "/tmp/proj",
    isSidechain: opts.sidechain ?? false,
    message: {
      id,
      model: opts.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: opts.input ?? 100,
        output_tokens: opts.output ?? 50,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  });
}

function writeSession(root: string, name: string, lines: string[]): string {
  const p = join(root, "proj", name);
  writeFileSync(p, lines.map((l) => l + "\n").join(""));
  return p;
}

const NOW = 1_781_000_000_000;
function totalTokens(store: Store): number {
  const s = store.usageSummary(0, NOW * 2);
  return s.totalTokens;
}

describe("parseUsageLine", () => {
  it("parses a billable assistant line", () => {
    const e = parseUsageLine(line("msg_a", { input: 10, output: 5, cacheRead: 3 }));
    expect(e).not.toBeNull();
    expect(e!.messageId).toBe("msg_a");
    expect(e!.inputTokens).toBe(10);
    expect(e!.cacheReadTokens).toBe(3);
    expect(e!.ts).toBe(Date.parse("2026-06-12T03:00:00.000Z"));
  });

  it("rejects non-assistant, non-msg ids, zero-usage, and corrupt lines", () => {
    expect(parseUsageLine(line("msg_a", { type: "user" }))).toBeNull();
    expect(parseUsageLine(line("uuid-not-msg"))).toBeNull(); // <synthetic>-style id
    expect(parseUsageLine(line("msg_z", { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }))).toBeNull();
    expect(parseUsageLine("{not json")).toBeNull();
    expect(parseUsageLine("")).toBeNull();
  });
});

describe("ingestUsage", () => {
  it("dedups by message.id — re-ingesting the same file is idempotent", () => {
    const root = tmpRoot();
    // 3 lines but only 2 unique message.ids (msg_a repeated with identical usage)
    writeSession(root, "s.jsonl", [
      line("msg_a", { input: 100, output: 0 }),
      line("msg_a", { input: 100, output: 0 }),
      line("msg_b", { input: 50, output: 0 }),
    ]);
    const store = new Store(":memory:");
    const r1 = ingestUsage(store, NOW, root);
    expect(r1.inserted).toBe(2); // unique message.ids only
    expect(totalTokens(store)).toBe(150);
    const r2 = ingestUsage(store, NOW, root); // unchanged file → stat-skip
    expect(r2.inserted).toBe(0);
    expect(r2.scanned).toBe(0); // file body not re-read
    expect(totalTokens(store)).toBe(150);
    store.close();
  });

  it("keeps the completed streaming line (larger output) for a repeated msg_id", () => {
    const root = tmpRoot();
    // same msg_id written twice: partial (output 5) then final (output 227),
    // input/cache stable — the final, larger one must win.
    writeSession(root, "s.jsonl", [
      line("msg_s", { input: 100, output: 5, cacheRead: 1000 }),
      line("msg_s", { input: 100, output: 227, cacheRead: 1000 }),
    ]);
    const store = new Store(":memory:");
    ingestUsage(store, NOW, root);
    const totals = store.usageModelTotals(0, NOW * 2);
    expect(totals).toHaveLength(1);
    expect(totals[0].outputTokens).toBe(227); // final wins, not 5
    expect(totals[0].activeTokens).toBe(327); // 100+227
    // re-ingest is still idempotent (no further change)
    const store2 = new Store(":memory:");
    ingestUsage(store2, NOW, root);
    ingestUsage(store2, NOW, root);
    expect(store2.usageModelTotals(0, NOW * 2)[0].outputTokens).toBe(227);
    store.close(); store2.close();
  });

  it("ingests only appended lines incrementally", () => {
    const root = tmpRoot();
    const p = writeSession(root, "s.jsonl", [line("msg_a", { input: 100, output: 0 })]);
    const store = new Store(":memory:");
    expect(ingestUsage(store, NOW, root).inserted).toBe(1);
    appendFileSync(p, line("msg_b", { input: 30, output: 0 }) + "\n");
    const r = ingestUsage(store, NOW, root);
    expect(r.inserted).toBe(1); // only the new line
    expect(totalTokens(store)).toBe(130);
    store.close();
  });

  it("holds a partial trailing line until it is completed", () => {
    const root = tmpRoot();
    const p = join(root, "proj", "s.jsonl");
    // complete line + a partial line with NO trailing newline
    writeFileSync(p, line("msg_a", { input: 100, output: 0 }) + "\n" + line("msg_b", { input: 30, output: 0 }));
    const store = new Store(":memory:");
    expect(ingestUsage(store, NOW, root).inserted).toBe(1); // only the completed line
    expect(totalTokens(store)).toBe(100);
    // complete the partial line
    appendFileSync(p, "\n");
    expect(ingestUsage(store, NOW, root).inserted).toBe(1);
    expect(totalTokens(store)).toBe(130);
    store.close();
  });

  it("skips a corrupt line but keeps going past it", () => {
    const root = tmpRoot();
    writeSession(root, "s.jsonl", [
      line("msg_a", { input: 100, output: 0 }),
      "{ broken json ]",
      line("msg_b", { input: 30, output: 0 }),
    ]);
    const store = new Store(":memory:");
    expect(ingestUsage(store, NOW, root).inserted).toBe(2);
    expect(totalTokens(store)).toBe(130);
    store.close();
  });

  it("re-reads from the start when a file is truncated/rewritten", () => {
    const root = tmpRoot();
    const p = writeSession(root, "s.jsonl", [
      line("msg_a", { input: 100, output: 0 }),
      line("msg_b", { input: 30, output: 0 }),
    ]);
    const store = new Store(":memory:");
    ingestUsage(store, NOW, root);
    expect(totalTokens(store)).toBe(130);
    // rewrite shorter (truncate) with a new message
    writeFileSync(p, line("msg_c", { input: 7, output: 0 }) + "\n");
    const r = ingestUsage(store, NOW, root);
    expect(r.inserted).toBe(1); // msg_c (a/b already counted, PK dedups)
    expect(totalTokens(store)).toBe(137);
    store.close();
  });

  it("handles multibyte (한글) lines without corrupting the byte offset", () => {
    const root = tmpRoot();
    const p = join(root, "proj", "s.jsonl");
    const l1 = JSON.stringify({
      type: "assistant", requestId: "req_1", timestamp: "2026-06-12T03:00:00.000Z",
      message: { id: "msg_k1", model: "한글모델", usage: { input_tokens: 100, output_tokens: 0 } },
    });
    writeFileSync(p, l1 + "\n");
    const store = new Store(":memory:");
    expect(ingestUsage(store, NOW, root).inserted).toBe(1);
    appendFileSync(p, line("msg_k2", { input: 20, output: 0 }) + "\n");
    expect(ingestUsage(store, NOW, root).inserted).toBe(1); // offset resumed correctly
    expect(totalTokens(store)).toBe(120);
    store.close();
  });

  it("aggregates per-model active vs total tokens", () => {
    const root = tmpRoot();
    writeSession(root, "s.jsonl", [
      line("msg_a", { input: 100, output: 50, cacheCreate: 200, cacheRead: 9000, model: "opus" }),
      line("msg_b", { input: 10, output: 5, model: "sonnet" }),
    ]);
    const store = new Store(":memory:");
    ingestUsage(store, NOW, root);
    const totals = store.usageModelTotals(0, NOW * 2);
    expect(totals[0].model).toBe("opus"); // higher active tokens
    expect(totals[0].activeTokens).toBe(350); // 100+50+200, excludes cache_read
    expect(totals[0].totalTokens).toBe(9350);
    const cat = store.usageTokenCategoryTotals(0, NOW * 2);
    expect(cat.cacheRead).toBe(9000);
    store.close();
  });
});
