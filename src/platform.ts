import { execFile } from "node:child_process";

export type SupportedPlatform = "darwin" | "linux" | "other";

export function normalizePlatform(platform: NodeJS.Platform = process.platform): SupportedPlatform {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return "other";
}

export function browserCommand(platform: NodeJS.Platform = process.platform): { bin: string; args: string[] } | null {
  switch (normalizePlatform(platform)) {
    case "darwin": return { bin: "open", args: [] };
    case "linux": return { bin: "xdg-open", args: [] };
    default: return null;
  }
}

export function notificationCommand(
  title: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[] } | null {
  switch (normalizePlatform(platform)) {
    case "darwin": {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return {
        bin: "osascript",
        args: ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
      };
    }
    case "linux":
      return { bin: "notify-send", args: [title, message] };
    default:
      return null;
  }
}

/** Best-effort desktop notification. Missing desktop helpers never break polling. */
export function sendDesktopNotification(title: string, message: string): Promise<void> {
  const cmd = notificationCommand(title, message);
  if (!cmd) return Promise.resolve();
  return new Promise((resolve) => {
    execFile(cmd.bin, cmd.args, () => resolve());
  });
}

/** Best-effort browser opener. Returns false when the platform has no known opener. */
export function openBrowserUrl(url: string): boolean {
  const cmd = browserCommand();
  if (!cmd) return false;
  execFile(cmd.bin, [...cmd.args, url], () => {});
  return true;
}
