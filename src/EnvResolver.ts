import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return {};
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      vars[key] = value;
    }
    return vars;
  });

/**
 * Resolve all env vars from .env files with process.env fallback.
 *
 * Precedence: repo root .env > .sandcastle/.env > process.env
 * Only keys declared in a .env file are resolved from process.env.
 */
export const resolveEnv = (
  repoDir: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const rootEnv = yield* parseEnvFile(join(repoDir, ".env"));
    const sandcastleEnv = yield* parseEnvFile(
      join(repoDir, ".sandcastle", ".env"),
    );

    // Collect all declared keys from both files
    const allKeys = new Set([
      ...Object.keys(rootEnv),
      ...Object.keys(sandcastleEnv),
    ]);

    const result: Record<string, string> = {};
    for (const key of allKeys) {
      const value = rootEnv[key] || sandcastleEnv[key] || process.env[key];
      if (value) {
        result[key] = value;
      }
    }

    return result;
  });
