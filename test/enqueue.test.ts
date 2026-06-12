import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAsker } from "../src/enqueue.js";

/**
 * The asker exists because plain readline.question drops lines that arrive
 * between questions on piped (non-TTY) stdin — these tests pin that fix.
 */
describe("createAsker (piped stdin)", () => {
  it("answers sequential questions from lines that arrived all at once", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const asker = createAsker(input, output);
    input.write("answer-1\nanswer-2\nanswer-3\n");
    expect(await asker.question("q1: ")).toBe("answer-1");
    expect(await asker.question("q2: ")).toBe("answer-2");
    expect(await asker.question("q3: ")).toBe("answer-3");
    asker.close();
  });

  it("resolves pending questions with empty string on EOF instead of hanging", async () => {
    const input = new PassThrough();
    const asker = createAsker(input, new PassThrough());
    input.write("only-line\n");
    input.end();
    expect(await asker.question("q1: ")).toBe("only-line");
    expect(await asker.question("q2: ")).toBe("");
    expect(asker.isClosed()).toBe(true);
  });

  it("waits for input that arrives after the question is asked", async () => {
    const input = new PassThrough();
    const asker = createAsker(input, new PassThrough());
    const pending = asker.question("q: ");
    setTimeout(() => input.write("late\n"), 10);
    expect(await pending).toBe("late");
    asker.close();
  });
});
