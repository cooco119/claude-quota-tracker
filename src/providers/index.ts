import type { UsageProvider } from "../types.js";
import { ClaudeProvider } from "./claude.js";

// Interface seams for future providers — intentionally not implemented (Part A
// scope). When added, they implement UsageProvider and join this list:
//   codex.ts       -> class CodexProvider implements UsageProvider
//   antigravity.ts -> class AntigravityProvider implements UsageProvider

export function allProviders(): UsageProvider[] {
  return [new ClaudeProvider()];
}

export { ClaudeProvider };
