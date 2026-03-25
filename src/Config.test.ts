import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Exit } from "effect";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "./Config.js";

const setupConfigDir = async (
  repoDir: string,
  config: Record<string, unknown>,
) => {
  const configDir = join(repoDir, ".sandcastle");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify(config));
};

const run = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));

const runExit = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(NodeContext.layer)));

const expectConfigError = (exit: Exit.Exit<unknown, unknown>): string => {
  expect(exit._tag).toBe("Failure");
  if (exit._tag !== "Failure") throw new Error("unreachable");
  const error = Cause.failureOption(exit.cause);
  expect(error._tag).toBe("Some");
  if (error._tag !== "Some") throw new Error("unreachable");
  expect(error.value).toBeInstanceOf(ConfigError);
  return (error.value as ConfigError).message;
};

describe("readConfig", () => {
  it("reads defaultMaxIterations from config", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, { defaultMaxIterations: 10 });

    const config = await run(readConfig(repoDir));
    expect(config.defaultMaxIterations).toBe(10);
  });

  it("returns undefined for defaultMaxIterations when not set", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {});

    const config = await run(readConfig(repoDir));
    expect(config.defaultMaxIterations).toBeUndefined();
  });

  it("returns empty config when file does not exist", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));

    const config = await run(readConfig(repoDir));
    expect(config.defaultMaxIterations).toBeUndefined();
  });

  it("rejects old defaultIterations key with clear error", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, { defaultIterations: 10 });

    const exit = await runExit(readConfig(repoDir));
    const message = expectConfigError(exit);
    expect(message).toContain("defaultIterations");
    expect(message).toContain("defaultMaxIterations");
  });

  it("throws ConfigError on unknown top-level key", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, { postSyncIn: "npm install" });

    const exit = await runExit(readConfig(repoDir));
    const message = expectConfigError(exit);
    expect(message).toContain("unexpected");
    expect(message).toContain("postSyncIn");
  });

  it("throws ConfigError on unknown hook name", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {
      hooks: { onBeforeRun: [{ command: "echo hi" }] },
    });

    const exit = await runExit(readConfig(repoDir));
    const message = expectConfigError(exit);
    expect(message).toContain("unexpected");
    expect(message).toContain("onBeforeRun");
  });

  it("throws ConfigError on unknown key in hook definition", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {
      hooks: { onSandboxReady: [{ command: "echo hi", timeout: 5000 }] },
    });

    const exit = await runExit(readConfig(repoDir));
    const message = expectConfigError(exit);
    expect(message).toContain("unexpected");
    expect(message).toContain("timeout");
  });

  it("reads model from config", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, { model: "claude-sonnet-4-6" });

    const config = await run(readConfig(repoDir));
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("returns undefined for model when not set", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {});

    const config = await run(readConfig(repoDir));
    expect(config.model).toBeUndefined();
  });

  it("reads agent from config", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, { agent: "claude-code" });

    const config = await run(readConfig(repoDir));
    expect(config.agent).toBe("claude-code");
  });

  it("returns undefined for agent when not set", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {});

    const config = await run(readConfig(repoDir));
    expect(config.agent).toBeUndefined();
  });

  it("reads imageName from config", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, { imageName: "myapp:sandbox" });

    const config = await run(readConfig(repoDir));
    expect(config.imageName).toBe("myapp:sandbox");
  });

  it("returns undefined for imageName when not set", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {});

    const config = await run(readConfig(repoDir));
    expect(config.imageName).toBeUndefined();
  });

  it("accepts valid hooks config", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "config-test-"));
    await setupConfigDir(repoDir, {
      hooks: {
        onSandboxReady: [{ command: "npm install" }],
      },
      defaultMaxIterations: 3,
    });

    const config = await run(readConfig(repoDir));
    expect(config.hooks?.onSandboxReady?.[0]?.command).toBe("npm install");
    expect(config.defaultMaxIterations).toBe(3);
  });
});
