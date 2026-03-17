import { Effect, Layer } from "effect";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Sandbox, SandboxError, type SandboxService } from "./Sandbox.js";

const makeFilesystemSandbox = (sandboxDir: string): SandboxService => ({
  exec: (command, options) =>
    Effect.async((resume) => {
      execFile(
        "sh",
        ["-c", command],
        { cwd: options?.cwd ?? sandboxDir },
        (error, stdout, stderr) => {
          if (error && error.code === undefined) {
            resume(
              Effect.fail(
                new SandboxError("exec", `Failed to exec: ${error.message}`),
              ),
            );
          } else {
            resume(
              Effect.succeed({
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                exitCode:
                  typeof error?.code === "number" ? error.code : (0 as number),
              }),
            );
          }
        },
      );
    }),

  execStreaming: (command, onStdoutLine, options) =>
    Effect.async((resume) => {
      const proc = spawn("sh", ["-c", command], {
        cwd: options?.cwd ?? sandboxDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        stdoutChunks.push(line);
        onStdoutLine(line);
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk.toString());
      });

      proc.on("error", (error) => {
        resume(
          Effect.fail(
            new SandboxError(
              "execStreaming",
              `Failed to exec: ${error.message}`,
            ),
          ),
        );
      });

      proc.on("close", (code) => {
        resume(
          Effect.succeed({
            stdout: stdoutChunks.join("\n"),
            stderr: stderrChunks.join(""),
            exitCode: code ?? 0,
          }),
        );
      });
    }),

  copyIn: (hostPath, sandboxPath) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(sandboxPath), { recursive: true });
        await copyFile(hostPath, sandboxPath);
      },
      catch: (error) =>
        new SandboxError(
          "copyIn",
          `Failed to copy ${hostPath} -> ${sandboxPath}: ${error}`,
        ),
    }),

  copyOut: (sandboxPath, hostPath) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(hostPath), { recursive: true });
        await copyFile(sandboxPath, hostPath);
      },
      catch: (error) =>
        new SandboxError(
          "copyOut",
          `Failed to copy ${sandboxPath} -> ${hostPath}: ${error}`,
        ),
    }),
});

export const FilesystemSandbox = {
  layer: (sandboxDir: string): Layer.Layer<Sandbox> =>
    Layer.succeed(Sandbox, makeFilesystemSandbox(sandboxDir)),
};
