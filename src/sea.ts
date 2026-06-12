import { isSea as nodeIsSea } from "node:sea";

/** True when running as a baked single-executable (the `quota` binary). */
export function isSea(): boolean {
  try {
    return nodeIsSea();
  } catch {
    return false;
  }
}
