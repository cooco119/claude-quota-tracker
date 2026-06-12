import { CONFIG_PATH, DATA_DIR } from "./config.js";
import { dashboard } from "./dashboard.js";
import { enqueue } from "./enqueue.js";
import { runManualTask, runNightLoop } from "./executor.js";
import { install, uninstall } from "./install.js";
import { renderMenubar } from "./menubar.js";
import { pollOnce } from "./poller.js";
import { printHint, printStatus, printTasks } from "./report.js";

const HELP = `quota — Claude Max20 quota tracker & night task orchestrator

Usage:
  quota install            설치: 런처 설치 + launchd 등록 + SwiftBar 시작
  quota uninstall          launchd 해제 (데이터 보존)
  quota poll               usage 1회 폴링 (launchd가 5분마다 호출)
  quota executor           야간 큐 소화 루프 (보통 poll이 자동 발사)
  quota executor --task N  태스크 N 수동 실행 (destructive/긴급)
  quota enqueue            태스크 대화형 등록
  quota enqueue --night --prompt "..." --size xs --perm read-only
                           비대화형 등록 + 야간 저사용 시간 자동 실행
  quota status [--json]    현재 사용률·예측·7일 KPI 출력
  quota tasks [--json]     태스크 큐 상태 출력
  quota hint [--threshold N]  세션이 임계값 이상이면 넛지 1줄 (hook용)
  quota menubar            SwiftBar 플러그인 출력
  quota dashboard [--open] 로컬 웹 대시보드 기동 (멱등)
  quota ingest             세션 로그 → 전체 사용량 적재 (poll이 자동 수행)
  quota paths              config/data 경로 출력
`;

/** node:sqlite needs Node ≥22.5; fail with a clear message, not a module crash. */
function checkNodeVersion(): boolean {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) {
    console.error(
      `quota는 Node 22.5+ 가 필요합니다 (node:sqlite 내장). 현재: ${process.versions.node}`,
    );
    return false;
  }
  return true;
}

export async function main(argv: string[]): Promise<void> {
  if (!checkNodeVersion()) { process.exitCode = 1; return; }
  const cmd = argv[0];
  switch (cmd) {
    case "poll": {
      const latest = await pollOnce();
      const n = Object.values(latest.providers).reduce((s, p) => s + p.windows.length, 0);
      console.log(`[quota-tracker] polled ${n} window readings`);
      return;
    }
    case "executor": {
      const taskFlag = argv.indexOf("--task");
      if (taskFlag !== -1) {
        const ok = await runManualTask(Number(argv[taskFlag + 1]));
        process.exitCode = ok ? 0 : 1;
      } else {
        await runNightLoop();
      }
      return;
    }
    case "install":
      return install();
    case "uninstall":
      return uninstall();
    case "enqueue":
      return enqueue(argv.slice(1));
    case "menubar":
      console.log(renderMenubar());
      return;
    case "status":
      printStatus(argv.slice(1));
      return;
    case "tasks":
      printTasks(argv.slice(1));
      return;
    case "hint":
      printHint(argv.slice(1));
      return;
    case "ingest": {
      const { ingestUsage } = await import("./ingest.js");
      const { Store } = await import("./store.js");
      const { DB_PATH } = await import("./config.js");
      const store = new Store(DB_PATH);
      try {
        const r = ingestUsage(store, Date.now());
        console.log(
          `[quota-tracker] ingest: ${r.inserted} new events from ${r.scanned}/${r.files} files`,
        );
      } finally {
        store.close();
      }
      return;
    }
    case "dashboard":
      return dashboard(argv.slice(1));
    case "paths":
      console.log(`config: ${CONFIG_PATH}`);
      console.log(`data:   ${DATA_DIR}`);
      return;
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error("[quota-tracker] fatal:", e);
  process.exitCode = 1;
});
