import { describe, expect, it } from "vitest";
import { browserCommand, normalizePlatform, notificationCommand } from "../src/platform.js";

describe("platform helpers", () => {
  it("selects xdg-open on Linux", () => {
    expect(browserCommand("linux")).toEqual({ bin: "xdg-open", args: [] });
  });

  it("selects open on macOS", () => {
    expect(browserCommand("darwin")).toEqual({ bin: "open", args: [] });
  });

  it("selects notify-send on Linux", () => {
    expect(notificationCommand("title", "body", "linux")).toEqual({
      bin: "notify-send", args: ["title", "body"],
    });
  });

  it("selects osascript on macOS", () => {
    const cmd = notificationCommand("title", "body", "darwin");
    expect(cmd?.bin).toBe("osascript");
    expect(cmd?.args[0]).toBe("-e");
  });

  it("degrades gracefully on unsupported platforms", () => {
    expect(normalizePlatform("win32")).toBe("other");
    expect(browserCommand("win32")).toBeNull();
    expect(notificationCommand("t", "b", "win32")).toBeNull();
  });
});
