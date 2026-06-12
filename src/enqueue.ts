import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CONFIG_PATH, DB_PATH, loadConfig, saveConfigPatch } from "./config.js";
import { Store } from "./store.js";
import {
  confirmPhrase, currentTimezone, nightWindowConfirmPhrase, parseHHMMRange, TRIAGE,
} from "./tasks.js";
import { SIZE_ESTIMATES, type PermissionClass, type TaskSize } from "./types.js";

const SIZES: TaskSize[] = ["xs", "s", "m", "l", "xl"];
const CLASSES: PermissionClass[] = ["read-only", "write-scoped", "destructive"];

/**
 * write-scoped tasks run inside `git worktree add` (runner.ts); if the cwd
 * isn't a git work tree, that fails at execution time — possibly overnight.
 * Warn at enqueue so it's caught now, not at 2am.
 */
function warnIfNotGitWorktree(cls: PermissionClass, cwd: string): void {
  if (cls !== "write-scoped") return;
  try {
    execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
  } catch {
    console.warn(
      `⚠ 경고: write-scoped 태스크의 작업 디렉토리가 git 저장소가 아닙니다 (${cwd}).\n` +
      `  실행 시 git worktree 격리가 실패합니다. git 저장소 경로를 --cwd로 지정하세요.`,
    );
  }
}

/**
 * Line-queueing prompt reader. readline's question() drops lines that arrive
 * between questions on piped stdin (only a TTY paces input), which silently
 * kills scripted use — so buffer every line and answer questions in order.
 */
export function createAsker(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  const rl = createInterface({ input, output });
  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!("");
  });
  return {
    question(q: string): Promise<string> {
      output.write(q);
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed) return Promise.resolve("");
      return new Promise((res) => waiters.push(res));
    },
    close: () => rl.close(),
    isClosed: () => closed && queue.length === 0,
  };
}

export async function enqueueInteractive(): Promise<void> {
  const rl = createAsker();
  const ask = async (q: string, fallback?: string): Promise<string> => {
    const a = (await rl.question(q)).trim();
    return a || fallback || "";
  };

  try {
    const config = loadConfig();

    console.log("프롬프트 (빈 줄로 종료):");
    const lines: string[] = [];
    for (;;) {
      const line = await rl.question("> ");
      if (!line.trim()) break;
      lines.push(line);
    }
    const prompt = lines.join("\n").trim();
    if (!prompt) {
      console.error("프롬프트가 비어 있어 등록을 취소합니다.");
      return;
    }

    const cwd = await ask(`작업 디렉토리 [${process.cwd()}]: `, process.cwd());

    let size: TaskSize;
    for (;;) {
      const s = (await ask("사이즈 (xs/s/m/l/xl): ")) as TaskSize;
      if (SIZES.includes(s)) { size = s; break; }
      if (rl.isClosed()) throw new Error("stdin closed before a valid size was given");
      console.log("xs/s/m/l/xl 중 하나를 입력하세요.");
    }
    const est = SIZE_ESTIMATES[size];
    console.log(`  → 예상 ~${Math.round(est.tokens / 1000)}K tokens / ~${est.minutes}분`);

    const priority = Number(await ask("우선순위 (높을수록 먼저) [0]: ", "0")) || 0;
    const deferOk = (await ask("야간으로 연기 가능? (Y/n): ", "y")).toLowerCase() !== "n";

    console.log("\n권한 triage — 이 태스크가 하는 일에 가장 가까운 것은?");
    CLASSES.forEach((c, i) => console.log(`  ${i + 1}) ${c.padEnd(13)} ${TRIAGE[c].summary}`));
    let cls: PermissionClass;
    for (;;) {
      const n = Number(await ask("선택 [1-3]: "));
      if (Number.isInteger(n) && n >= 1 && n <= 3) { cls = CLASSES[n - 1]; break; }
      if (rl.isClosed()) throw new Error("stdin closed before a valid triage choice was given");
    }
    const rule = TRIAGE[cls];
    warnIfNotGitWorktree(cls, cwd);

    console.log(`\n${confirmPhrase(cls, config.nightWindow)}`);
    if (rule.unattendedOk) {
      const yes = (await ask("동의합니까? (y/N): ")).toLowerCase() === "y";
      if (!yes) {
        console.log("동의하지 않아 등록을 취소합니다.");
        return;
      }
    }

    const scheduledWindow = rule.unattendedOk && deferOk ? "night" : "any";

    // Night-slot task while the window is unconfirmed — or confirmed in a
    // different timezone (the gate refuses silently otherwise): confirm now.
    const tz = currentTimezone();
    const needsNightConfirm =
      scheduledWindow === "night" &&
      (!config.nightWindow.confirmedAt || config.nightWindow.confirmedTz !== tz);
    if (needsNightConfirm) {
      if (config.nightWindow.confirmedAt) {
        console.log(
          `\n타임존이 변경되었습니다 (${config.nightWindow.confirmedTz} → ${tz}). 재컨펌이 필요합니다.`,
        );
      }
      console.log(`\n${nightWindowConfirmPhrase(config.nightWindow, tz)}`);
      const a = (await ask('(y=허용 / n=보류 / 직접 입력 예 "00:30-07:00"): ')).toLowerCase();
      let { start, end } = config.nightWindow;
      let confirmed = false;
      const range = parseHHMMRange(a);
      if (range) { ({ start, end } = range); confirmed = true; }
      else if (a === "y") confirmed = true;
      else if (a !== "n" && a !== "") {
        console.log('입력을 해석하지 못했습니다 ("HH:MM-HH:MM" 또는 y/n) — 보류로 처리합니다.');
      }
      if (confirmed) {
        saveConfigPatch(
          {
            nightWindow: {
              start, end,
              confirmedAt: new Date().toISOString(),
              confirmedTz: tz,
            },
          },
          CONFIG_PATH,
        );
        console.log(`→ night window ${start}–${end} (${tz}) 컨펌 기록 완료`);
      } else {
        console.log("→ 보류: 컨펌 전까지 야간 배치는 실행되지 않습니다 (태스크는 등록됨).");
      }
    }

    const store = new Store(DB_PATH);
    try {
      const task = store.enqueueTask(Date.now(), {
        prompt, cwd, size, priority, deferOk,
        permissionClass: cls,
        permissionMode: rule.permissionMode,
        unattendedOk: rule.unattendedOk,
        scheduledWindow,
      });
      console.log(
        `\n✓ task #${task.id} 등록 — ${size} / ${cls} / ${rule.permissionMode} / ` +
        `${scheduledWindow} 슬롯 / 우선순위 ${priority}`,
      );
      if (!rule.unattendedOk) {
        console.log(`  무인 실행 불가 — 실행: npm run executor -- --task ${task.id}`);
        console.log("  (estimation 누적을 위해 수동 실행도 동일 스케줄러 경로를 탑니다)");
      }
    } finally {
      store.close();
    }
  } finally {
    rl.close();
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/**
 * Non-interactive enqueue from flags:
 *   quota enqueue --prompt "..." --size xs --perm read-only [--night]
 *                 [--cwd PATH] [--priority N]
 * --night opts the task into unattended night execution (and records the
 * night-window confirmation, since the flag itself is the explicit opt-in).
 */
export function enqueueFromArgs(argv: string[]): void {
  const f = parseFlags(argv);
  const prompt = typeof f.prompt === "string" ? f.prompt.trim() : "";
  const size = f.size as TaskSize;
  const cls = f.perm as PermissionClass;
  if (!prompt) { console.error("--prompt <text> 필요"); process.exitCode = 1; return; }
  if (!SIZES.includes(size)) { console.error("--size xs|s|m|l|xl 필요"); process.exitCode = 1; return; }
  if (!CLASSES.includes(cls)) { console.error("--perm read-only|write-scoped|destructive 필요"); process.exitCode = 1; return; }

  const cwd = typeof f.cwd === "string" ? f.cwd : process.cwd();
  const priority = typeof f.priority === "string" ? Number(f.priority) || 0 : 0;
  const wantNight = f.night === true || f.night === "true";
  const rule = TRIAGE[cls];
  warnIfNotGitWorktree(cls, cwd);

  let scheduledWindow: "night" | "any" = "any";
  let deferOk = false;
  if (wantNight) {
    if (!rule.unattendedOk) {
      console.warn(`경고: ${cls}는 무인 실행 불가 — --night 무시, 'any' 슬롯(수동 실행)으로 등록`);
    } else {
      scheduledWindow = "night";
      deferOk = true;
    }
  }

  const config = loadConfig();
  const tz = currentTimezone();
  if (
    scheduledWindow === "night" &&
    (!config.nightWindow.confirmedAt || config.nightWindow.confirmedTz !== tz)
  ) {
    saveConfigPatch(
      {
        nightWindow: {
          start: config.nightWindow.start, end: config.nightWindow.end,
          confirmedAt: new Date().toISOString(), confirmedTz: tz,
        },
      },
      CONFIG_PATH,
    );
    console.log(
      `→ night window ${config.nightWindow.start}–${config.nightWindow.end} (${tz}) 자동 컨펌 (--night)`,
    );
  }

  const store = new Store(DB_PATH);
  try {
    const task = store.enqueueTask(Date.now(), {
      prompt, cwd, size, priority, deferOk,
      permissionClass: cls, permissionMode: rule.permissionMode,
      unattendedOk: rule.unattendedOk, scheduledWindow,
    });
    console.log(
      `✓ task #${task.id} 등록 — ${size} / ${cls} / ${rule.permissionMode} / ` +
      `${scheduledWindow} 슬롯 / 우선순위 ${priority}`,
    );
    if (scheduledWindow === "night") {
      console.log("  야간 윈도우의 사용량 최저 시간에 자동 실행됩니다 (데이터 누적 전엔 윈도우 시작 시각).");
    }
    if (!rule.unattendedOk) {
      console.log(`  무인 실행 불가 — 실행: quota executor --task ${task.id}`);
    }
  } finally {
    store.close();
  }
}

/** Route: flags present → non-interactive, otherwise the interactive prompt. */
export function enqueue(argv: string[]): Promise<void> | void {
  if (argv.length > 0) return enqueueFromArgs(argv);
  return enqueueInteractive();
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  Promise.resolve(enqueue(process.argv.slice(2))).catch((e) => {
    console.error("[enqueue] failed:", e);
    process.exitCode = 1;
  });
}
