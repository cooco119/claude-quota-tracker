import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_PROJECTS_DIR, loadConfig } from "./config.js";
import type { Store } from "./store.js";
import type { UsageEvent } from "./types.js";

const NL = 0x0a; // '\n'

function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Default scan roots: ~/.claude/projects + any config extraRoots (custom harnesses). */
export function resolveIngestRoots(): string[] {
  const extra = loadConfig().ingest.extraRoots.map(expandTilde);
  const seen = new Set<string>();
  return [CLAUDE_PROJECTS_DIR, ...extra].filter((r) => {
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });
}

/**
 * Every *.jsonl under a root, walked recursively. ~/.claude/projects is two
 * levels deep, but custom harnesses (CCS) nest sessions and subagent
 * transcripts arbitrarily deep, so we recurse. Symlinked dirs are not followed
 * (Node's recursive readdir skips them), avoiding loops.
 */
function listSessionFiles(root: string): string[] {
  let entries: Array<{ name: string; parentPath: string; isFile(): boolean }>;
  try {
    entries = readdirSync(root, { withFileTypes: true, recursive: true }) as never;
  } catch {
    return []; // root doesn't exist
  }
  const files: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) files.push(join(e.parentPath, e.name));
  }
  return files;
}

/**
 * Read whole lines from `path` starting at `fromOffset`. Returns the decoded
 * complete lines and the byte offset just past the last newline. Bytes after
 * the last newline (a line still being written) are left for the next tick.
 * Splitting on the newline BYTE is multibyte-safe: 0x0a never appears inside a
 * UTF-8 continuation byte, so no character is ever cut.
 */
function readCompleteLines(
  path: string, fromOffset: number, size: number,
): { lines: string[]; newOffset: number } {
  const len = size - fromOffset;
  if (len <= 0) return { lines: [], newOffset: fromOffset };
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, fromOffset + read);
      if (n === 0) break;
      read += n;
    }
    const lastNL = buf.lastIndexOf(NL, read - 1);
    if (lastNL === -1) return { lines: [], newOffset: fromOffset }; // no complete line yet
    const text = buf.toString("utf8", 0, lastNL); // excludes the trailing newline
    return {
      lines: text.length === 0 ? [] : text.split("\n"),
      newOffset: fromOffset + lastNL + 1,
    };
  } finally {
    closeSync(fd);
  }
}

interface RawLine {
  type?: string;
  requestId?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/** Parse one jsonl line into a UsageEvent, or null if it isn't billable usage. */
export function parseUsageLine(line: string): UsageEvent | null {
  let o: RawLine;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // corrupt/partial line
  }
  if (o.type !== "assistant") return null;
  const m = o.message;
  const u = m?.usage;
  const id = m?.id;
  // Real assistant messages have msg_ ids; <synthetic> entries use UUID ids
  // and carry no real tokens.
  if (!u || !id || !id.startsWith("msg_") || !m?.model) return null;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheCreation = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  if (input + output + cacheCreation + cacheRead === 0) return null;
  // A timestamp-less billable line is intentionally dropped: usage_events.ts is
  // the sole axis for the time-window aggregation that is this feature's only
  // output, so an event with no time has nowhere to go. Real Claude Code logs
  // always carry `timestamp` on assistant entries (0 missing across the corpus),
  // so this is a latent guard, not an observed loss.
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  return {
    messageId: id,
    requestId: o.requestId ?? null,
    ts,
    model: m.model,
    sessionId: o.sessionId ?? null,
    cwd: o.cwd ?? null,
    isSidechain: o.isSidechain === true,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
  };
}

/**
 * Incrementally ingest all Claude Code session logs into usage_events.
 * Unchanged files (size+mtime+ino match the cursor) are stat-only, never read.
 * Returns counts for `quota ingest` / debugging.
 */
export function ingestUsage(
  store: Store, nowMs: number, roots?: string | string[],
): { files: number; scanned: number; inserted: number } {
  const rootList = roots === undefined
    ? resolveIngestRoots()
    : Array.isArray(roots) ? roots : [roots];
  let scanned = 0;
  let inserted = 0;
  const files = rootList.flatMap(listSessionFiles);
  for (const path of files) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // deleted/moved mid-scan
    }
    const cursor = store.getCursor(path);
    const unchanged =
      cursor &&
      cursor.lastSize === st.size &&
      cursor.lastMtimeMs === st.mtimeMs &&
      cursor.lastIno === Number(st.ino);
    if (unchanged) continue;

    // Resume from the cursor, unless the file shrank or its inode changed
    // (truncate / rotation / in-place replace) — then re-read from the start.
    // The message_id PK makes a full re-read idempotent.
    const rotated =
      cursor && (st.size < cursor.byteOffset || cursor.lastIno !== Number(st.ino));
    const fromOffset = !cursor || rotated ? 0 : cursor.byteOffset;

    scanned++;
    const { lines, newOffset } = readCompleteLines(path, fromOffset, st.size);
    const events: UsageEvent[] = [];
    for (const line of lines) {
      const e = parseUsageLine(line);
      if (e) events.push(e);
    }
    const res = store.ingestFile({
      path, size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino),
      newByteOffset: newOffset, events, nowMs,
    });
    inserted += res.inserted;
  }
  return { files: files.length, scanned, inserted };
}
