import { FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import { join } from "node:path";

const HookDefinition = Schema.Struct({
  command: Schema.String,
}).annotations({ title: "HookDefinition" });

const SandcastleConfigSchema = Schema.Struct({
  hooks: Schema.optional(
    Schema.Struct({
      onSandboxReady: Schema.optional(Schema.Array(HookDefinition)),
    }),
  ),
  defaultMaxIterations: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  imageName: Schema.optional(Schema.String),
}).annotations({ title: "SandcastleConfig" });

export type HookDefinition = typeof HookDefinition.Type;
export type SandcastleConfig = typeof SandcastleConfigSchema.Type;

export class ConfigError extends Error {
  readonly _tag = "ConfigError";
  constructor(message: string) {
    super(message);
  }
}

const RENAMED_KEYS: Record<string, string> = {
  defaultIterations: "defaultMaxIterations",
};

const decodeConfig = Schema.decodeUnknownEither(SandcastleConfigSchema, {
  onExcessProperty: "error",
});

export const readConfig = (
  repoDir: string,
): Effect.Effect<SandcastleConfig, ConfigError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(join(repoDir, ".sandcastle", "config.json"))
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return {} as SandcastleConfig;

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return yield* Effect.fail(new ConfigError("Invalid JSON in config.json"));
    }

    // Check for renamed keys and produce clear errors
    if (typeof raw === "object" && raw !== null) {
      for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
        if (oldKey in raw) {
          return yield* Effect.fail(
            new ConfigError(
              `"${oldKey}" has been renamed to "${newKey}" in config.json. Please update your config.`,
            ),
          );
        }
      }
    }

    const result = decodeConfig(raw);
    if (result._tag === "Left") {
      return yield* Effect.fail(new ConfigError(result.left.message));
    }

    return result.right;
  });
