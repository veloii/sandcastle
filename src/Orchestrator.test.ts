import { Effect, Layer } from "effect";
import { exec } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import {
  orchestrate,
  parseStreamJsonLine,
  type OrchestrateOptions,
} from "./Orchestrator.js";
import { Sandbox } from "./Sandbox.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const getHead = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
  return stdout.trim();
};

/** Format a mock agent result as stream-json lines (mimicking Claude's output) */
const toStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
  );
  lines.push(JSON.stringify({ type: "result", result: output }));
  return lines.join("\n");
};

/**
 * Create a mock sandbox layer that intercepts `claude` commands
 * and runs a mock script instead. All other commands pass through
 * to the filesystem sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = FilesystemSandbox.layer(sandboxDir);

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      // Intercept claude invocations
      if (command.startsWith("claude ")) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      // Pass through to real filesystem sandbox
      return Effect.flatMap(Sandbox, (real) =>
        real.exec(command, options),
      ).pipe(Effect.provide(fsLayer));
    },
    execStreaming: (command, onStdoutLine, options) => {
      // Intercept claude invocations
      if (command.startsWith("claude ")) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          const streamOutput = toStreamJson(output);
          // Emit each line to the callback
          for (const line of streamOutput.split("\n")) {
            onStdoutLine(line);
          }
          return { stdout: streamOutput, stderr: "", exitCode: 0 };
        });
      }
      // Pass through to real filesystem sandbox
      return Effect.flatMap(Sandbox, (real) =>
        real.execStreaming(command, onStdoutLine, options),
      ).pipe(Effect.provide(fsLayer));
    },
    copyIn: (hostPath, sandboxPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyIn(hostPath, sandboxPath),
      ).pipe(Effect.provide(fsLayer)),
    copyOut: (sandboxPath, hostPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyOut(sandboxPath, hostPath),
      ).pipe(Effect.provide(fsLayer)),
  });
};

describe("Orchestrator", () => {
  it("runs a single iteration: sync-in, agent, sync-out", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "orch-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: creates a commit in the sandbox repo
    const layer = makeMockAgentLayer(sandboxDir, async (repoDir) => {
      await writeFile(join(repoDir, "agent-output.txt"), "agent was here");
      await execAsync("git add -A", { cwd: repoDir });
      await execAsync('git config user.email "agent@test.com"', {
        cwd: repoDir,
      });
      await execAsync('git config user.name "Agent"', { cwd: repoDir });
      await execAsync('git commit -m "RALPH: agent commit"', { cwd: repoDir });
      return "Done with iteration.";
    });

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        repoFullName: "test/repo",
        prompt: "do some work",
      }).pipe(Effect.provide(layer)),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.complete).toBe(false);

    // Verify the agent's commit was synced back to host
    const content = await readFile(join(hostDir, "agent-output.txt"), "utf-8");
    expect(content).toBe("agent was here");
  });

  it("stops early on completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "orch-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits completion signal
    const layer = makeMockAgentLayer(sandboxDir, async () => {
      return "All done. <promise>COMPLETE</promise>";
    });

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        repoFullName: "test/repo",
        prompt: "do some work",
      }).pipe(Effect.provide(layer)),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("runs multiple iterations with re-sync between them", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "orch-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iterationCount = 0;

    // Mock agent: creates a commit each iteration, completes on iteration 3
    const layer = makeMockAgentLayer(sandboxDir, async (repoDir) => {
      iterationCount++;
      const filename = `iter-${iterationCount}.txt`;
      await writeFile(join(repoDir, filename), `iteration ${iterationCount}`);
      await execAsync("git add -A", { cwd: repoDir });
      await execAsync('git config user.email "agent@test.com"', {
        cwd: repoDir,
      });
      await execAsync('git config user.name "Agent"', { cwd: repoDir });
      await execAsync(`git commit -m "RALPH: iteration ${iterationCount}"`, {
        cwd: repoDir,
      });

      if (iterationCount === 3) {
        return "All tasks done. <promise>COMPLETE</promise>";
      }
      return `Finished iteration ${iterationCount}.`;
    });

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        repoFullName: "test/repo",
        prompt: "do some work",
      }).pipe(Effect.provide(layer)),
    );

    expect(result.iterationsRun).toBe(3);
    expect(result.complete).toBe(true);

    // Verify all 3 iteration files arrived on host
    for (let i = 1; i <= 3; i++) {
      const content = await readFile(join(hostDir, `iter-${i}.txt`), "utf-8");
      expect(content).toBe(`iteration ${i}`);
    }
  });

  it("handles iteration with no agent commits gracefully", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "orch-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: doesn't make any commits
    const layer = makeMockAgentLayer(sandboxDir, async () => {
      return "Nothing to do.";
    });

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 2,
        repoFullName: "test/repo",
        prompt: "do some work",
      }).pipe(Effect.provide(layer)),
    );

    expect(result.iterationsRun).toBe(2);
    expect(result.complete).toBe(false);

    // Host should still be at the original commit
    const hostHead = await getHead(hostDir);
    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("parseStreamJsonLine", () => {
  it("extracts text from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual({
      type: "text",
      text: "Hello world",
    });
  });

  it("extracts result from result message", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(parseStreamJsonLine(line)).toEqual({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
  });

  it("returns null for non-JSON lines", () => {
    expect(parseStreamJsonLine("not json")).toBeNull();
    expect(parseStreamJsonLine("")).toBeNull();
  });

  it("returns null for unrecognized JSON types", () => {
    const line = JSON.stringify({ type: "system", data: "something" });
    expect(parseStreamJsonLine(line)).toBeNull();
  });

  it("handles multiple text content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual({
      type: "text",
      text: "Hello world",
    });
  });

  it("skips non-text content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "123" },
          { type: "text", text: "result" },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual({ type: "text", text: "result" });
  });
});

describe("Orchestrator streaming", () => {
  it("invokes claude with stream-json and verbose flags", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "orch-stream-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const fsLayer = FilesystemSandbox.layer(sandboxDir);
    const layer = Layer.succeed(Sandbox, {
      exec: (command, options) =>
        Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
          Effect.provide(fsLayer),
        ),
      execStreaming: (command, onStdoutLine, options) => {
        if (command.startsWith("claude ")) {
          capturedCommand = command;
          const output = "Test output";
          const streamOutput = toStreamJson(output);
          for (const line of streamOutput.split("\n")) {
            onStdoutLine(line);
          }
          return Effect.succeed({
            stdout: streamOutput,
            stderr: "",
            exitCode: 0,
          });
        }
        return Effect.flatMap(Sandbox, (real) =>
          real.execStreaming(command, onStdoutLine, options),
        ).pipe(Effect.provide(fsLayer));
      },
      copyIn: (hostPath, sandboxPath) =>
        Effect.flatMap(Sandbox, (real) =>
          real.copyIn(hostPath, sandboxPath),
        ).pipe(Effect.provide(fsLayer)),
      copyOut: (sandboxPath, hostPath) =>
        Effect.flatMap(Sandbox, (real) =>
          real.copyOut(sandboxPath, hostPath),
        ).pipe(Effect.provide(fsLayer)),
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        repoFullName: "test/repo",
        prompt: "do some work",
      }).pipe(Effect.provide(layer)),
    );

    expect(capturedCommand).toContain("--output-format stream-json");
    expect(capturedCommand).toContain("--verbose");
    expect(capturedCommand).not.toContain("--output-format text");
  });

  it("extracts completion signal from stream-json result line", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "orch-result-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent that emits completion via stream-json result type
    const layer = makeMockAgentLayer(sandboxDir, async () => {
      return "All done. <promise>COMPLETE</promise>";
    });

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,
        repoFullName: "test/repo",
        prompt: "do some work",
      }).pipe(Effect.provide(layer)),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.complete).toBe(true);
  });
});
