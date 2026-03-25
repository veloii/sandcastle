import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";
import { PromptError } from "./errors.js";

export interface ResolvePromptOptions {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly cwd?: string;
}

export const resolvePrompt = (
  options: ResolvePromptOptions,
): Effect.Effect<string, PromptError, FileSystem.FileSystem> => {
  const { prompt, promptFile, cwd = process.cwd() } = options;

  if (prompt !== undefined && promptFile !== undefined) {
    return Effect.fail(
      new PromptError({
        message: "Cannot provide both --prompt and --prompt-file",
      }),
    );
  }

  if (prompt !== undefined) {
    return Effect.succeed(prompt);
  }

  const path = promptFile ?? join(cwd, ".sandcastle", "prompt.md");

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(path).pipe(
      Effect.catchAll((e) =>
        Effect.fail(
          new PromptError({
            message: `Failed to read prompt from ${path}: ${e}`,
          }),
        ),
      ),
    );
  });
};
