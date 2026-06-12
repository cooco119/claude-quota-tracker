import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, saveConfigPatch } from "./config.js";

const LABEL = "com.quota-tracker.poller";
// Pre-distribution label; install/uninstall clean it up so it isn't orphaned.
const LEGACY_LABEL = "com.jaejun.quota-tracker.poller";
// Install always targets ~/.quota-tracker, regardless of where `install` is
// invoked from (the config.ts path constants resolve to the repo when run via
// `node dist/cli.js install` without QUOTA_TRACKER_HOME set).
const APP_HOME = join(homedir(), ".quota-tracker");
const APP_DATA = join(APP_HOME, "data");
const APP_CONFIG = join(APP_HOME, "config.json");
const APP_PLUGINS = join(APP_HOME, "plugins");
const LIB_DIST = join(APP_HOME, "lib", "dist");
const LAUNCHER = join(homedir(), ".local", "bin", "quota");

function plistPath(label: string = LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/** Boot out and remove a launchd agent by label (ignore if absent). */
function removeAgent(label: string): void {
  const uid = process.getuid!();
  run("launchctl", ["bootout", `gui/${uid}/${label}`], { allowFail: true });
  run("rm", ["-f", plistPath(label)], { allowFail: true });
}

/**
 * Prefer a stable node path over process.execPath: the latter is the versioned
 * Homebrew Cellar path (…/node/25.9.0_2/bin/node), which `brew upgrade node`
 * deletes — breaking the launcher and launchd agent across reboots/upgrades.
 * The /opt/homebrew/bin/node symlink follows upgrades.
 */
function resolveNodePath(): string {
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(p)) return p;
  }
  return process.execPath;
}

function run(bin: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (opts.allowFail) return "";
    throw e;
  }
}

/**
 * Copy the compiled dist into ~/.quota-tracker/lib and write a launcher that
 * runs it with the system node. This replaces the SEA single-binary: an
 * ad-hoc-signed 127MB Mach-O is killed by the Apple Silicon kernel once `cp`
 * breaks its signature (SIGKILL / exit 137). node is already a hard dependency,
 * so a launcher is both lighter and far more robust.
 */
function installRuntime(nodePath: string): void {
  const srcDist = dirname(fileURLToPath(import.meta.url)); // this file lives in dist/
  // Guard against self-destruction: when `quota install` runs through the
  // installed launcher, srcDist IS LIB_DIST. rm+copy would delete the source
  // mid-flight (ENOENT lstat) and wipe the runtime. The runtime is already in
  // place, so just refresh the launcher.
  if (resolve(srcDist) !== resolve(LIB_DIST)) {
    rmSync(LIB_DIST, { recursive: true, force: true });
    mkdirSync(dirname(LIB_DIST), { recursive: true });
    cpSync(srcDist, LIB_DIST, { recursive: true });
    console.log(`✓ runtime → ${LIB_DIST}`);
  } else {
    console.log(`✓ runtime already installed (${LIB_DIST})`);
  }

  mkdirSync(dirname(LAUNCHER), { recursive: true });
  writeFileSync(
    LAUNCHER,
    `#!/bin/sh\n` +
    `export QUOTA_TRACKER_HOME="\${QUOTA_TRACKER_HOME:-$HOME/.quota-tracker}"\n` +
    `exec "${nodePath}" "${join(LIB_DIST, "cli.js")}" "$@"\n`,
  );
  chmodSync(LAUNCHER, 0o755);
  console.log(`✓ launcher → ${LAUNCHER}`);
}

function installHome(): void {
  mkdirSync(APP_DATA, { recursive: true });
  if (!existsSync(APP_CONFIG)) {
    saveConfigPatch({ ...DEFAULT_CONFIG }, APP_CONFIG);
    console.log(`✓ default config → ${APP_CONFIG}`);
  }
  console.log(`✓ home: ${APP_HOME}`);
}

function installLaunchd(nodePath: string): void {
  const path = plistPath();
  const env = `${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  // launchd calls node directly (no shell) and gets the home via env.
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${nodePath}</string><string>${join(LIB_DIST, "cli.js")}</string><string>poll</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${env}</string>
    <key>QUOTA_TRACKER_HOME</key><string>${APP_HOME}</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(APP_DATA, "poller.log")}</string>
  <key>StandardErrorPath</key><string>${join(APP_DATA, "poller.err.log")}</string>
</dict>
</plist>
`);
  const uid = process.getuid!();
  removeAgent(LEGACY_LABEL); // migrate off the old per-author label
  run("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { allowFail: true });
  run("launchctl", ["bootstrap", `gui/${uid}`, path]);
  console.log(`✓ launchd agent loaded (${LABEL}, 5분 주기)`);
}

function installSwiftBar(): void {
  const pluginDir = APP_PLUGINS;
  mkdirSync(pluginDir, { recursive: true });
  const plugin = join(pluginDir, "usage.1m.sh");
  writeFileSync(plugin, `#!/bin/bash\nexec "${LAUNCHER}" menubar\n`);
  chmodSync(plugin, 0o755);

  const appInstalled =
    existsSync("/Applications/SwiftBar.app") ||
    existsSync(join(homedir(), "Applications", "SwiftBar.app"));
  if (!appInstalled) {
    const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(existsSync);
    if (!brew) {
      console.log("⚠ SwiftBar 미설치 + brew 없음 — https://swiftbar.app 에서 설치 후:");
      console.log(`  플러그인 폴더를 ${pluginDir} 로 지정`);
      return;
    }
    console.log("… SwiftBar 설치 중 (brew install --cask swiftbar)");
    execFileSync(brew, ["install", "--cask", "swiftbar"], { stdio: "inherit" });
  }

  const current = run(
    "defaults", ["read", "com.ameba.SwiftBar", "PluginDirectory"], { allowFail: true },
  ).trim();
  if (!current) {
    run("defaults", ["write", "com.ameba.SwiftBar", "PluginDirectory", pluginDir]);
    console.log(`✓ SwiftBar 플러그인 폴더 → ${pluginDir}`);
  } else if (resolve(current) !== resolve(pluginDir)) {
    const link = join(current, "usage.1m.sh");
    if (!existsSync(link)) copyFileSync(plugin, link);
    chmodSync(link, 0o755);
    console.log(`✓ 기존 SwiftBar 플러그인 폴더(${current})에 usage.1m.sh 설치`);
  }
  const appPath = ["/Applications/SwiftBar.app", join(homedir(), "Applications", "SwiftBar.app")]
    .find(existsSync);
  run("open", appPath ? [appPath] : ["-a", "SwiftBar"]);
  console.log("✓ SwiftBar 시작됨 (menubar에 CQ 항목 확인)");
}

export async function install(): Promise<void> {
  const nodePath = resolveNodePath();
  installRuntime(nodePath);
  installHome();
  installLaunchd(nodePath);
  installSwiftBar();
  console.log("\n설치 완료. 다음 단계:");
  console.log("  quota status    — 현재 사용률 확인");
  console.log("  quota enqueue   — 첫 태스크 등록 (night window 컨펌 포함)");
  console.log(`  config 수정     — ${APP_CONFIG}`);
}

export async function uninstall(): Promise<void> {
  removeAgent(LABEL);
  removeAgent(LEGACY_LABEL);
  console.log(`✓ launchd agent 해제 (${LABEL})`);
  console.log(`데이터는 보존됩니다: ${APP_HOME}`);
  console.log(`런처/런타임 제거: rm ${LAUNCHER}; rm -rf ${join(APP_HOME, "lib")}`);
}
