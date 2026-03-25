import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePrompt } from "./PromptResolver.js";
import { PromptError } from "./errors.js";

const run = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));

describe("PromptResolver", () => {
  it("returns inline prompt when prompt is provided", async () => {
    const result = await run(resolvePrompt({ prompt: "do some work" }));
    expect(result).toBe("do some work");
  });

  it("reads prompt from promptFile when provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-resolver-"));
    const promptPath = join(dir, "custom-prompt.md");
    await writeFile(promptPath, "prompt from file");

    const result = await run(resolvePrompt({ promptFile: promptPath }));
    expect(result).toBe("prompt from file");
  });

  it("errors when both prompt and promptFile are provided", async () => {
    const error = await run(
      resolvePrompt({ prompt: "inline", promptFile: "/some/file.md" }).pipe(
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("both");
  });

  it("defaults to .sandcastle/prompt.md when neither is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-resolver-"));
    await mkdir(join(dir, ".sandcastle"), { recursive: true });
    await writeFile(join(dir, ".sandcastle", "prompt.md"), "default prompt");

    const result = await run(resolvePrompt({ cwd: dir }));
    expect(result).toBe("default prompt");
  });

  it("errors when default prompt file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-resolver-"));

    const error = await run(resolvePrompt({ cwd: dir }).pipe(Effect.flip));
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("prompt");
  });
});
