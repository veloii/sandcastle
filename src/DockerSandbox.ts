import { Effect, Layer } from "effect";
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Sandbox, SandboxError, type SandboxService } from "./Sandbox.js";

const makeDockerSandbox = (containerName: string): SandboxService => ({
  exec: (command, options) =>
    Effect.async((resume) => {
      const args = ["exec"];
      if (options?.cwd) {
        args.push("-w", options.cwd);
      }
      args.push(containerName, "sh", "-c", command);

      execFile(
        "docker",
        args,
        { maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && error.code === undefined) {
            resume(
              Effect.fail(
                new SandboxError(
                  "exec",
                  `docker exec failed: ${error.message}`,
                ),
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
      const args = ["exec"];
      if (options?.cwd) {
        args.push("-w", options.cwd);
      }
      args.push(containerName, "sh", "-c", command);

      const proc = spawn("docker", args, {
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
              `docker exec streaming failed: ${error.message}`,
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
    Effect.gen(function* () {
      // Ensure parent directory exists in container
      const parentDir = dirname(sandboxPath);
      yield* Effect.async<void, SandboxError>((resume) => {
        execFile(
          "docker",
          ["exec", containerName, "mkdir", "-p", parentDir],
          (error) => {
            if (error) {
              resume(
                Effect.fail(
                  new SandboxError(
                    "copyIn",
                    `Failed to create dir ${parentDir}: ${error.message}`,
                  ),
                ),
              );
            } else {
              resume(Effect.succeed(undefined));
            }
          },
        );
      });

      // docker cp hostPath containerName:sandboxPath
      yield* Effect.async<void, SandboxError>((resume) => {
        execFile(
          "docker",
          ["cp", hostPath, `${containerName}:${sandboxPath}`],
          (error) => {
            if (error) {
              resume(
                Effect.fail(
                  new SandboxError(
                    "copyIn",
                    `Failed to copy ${hostPath} -> ${containerName}:${sandboxPath}: ${error.message}`,
                  ),
                ),
              );
            } else {
              resume(Effect.succeed(undefined));
            }
          },
        );
      });
    }),

  copyOut: (sandboxPath, hostPath) =>
    Effect.gen(function* () {
      // Ensure parent directory exists on host
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(hostPath), { recursive: true }),
        catch: (error) =>
          new SandboxError(
            "copyOut",
            `Failed to create host dir ${dirname(hostPath)}: ${error}`,
          ),
      });

      // docker cp containerName:sandboxPath hostPath
      yield* Effect.async<void, SandboxError>((resume) => {
        execFile(
          "docker",
          ["cp", `${containerName}:${sandboxPath}`, hostPath],
          (error) => {
            if (error) {
              resume(
                Effect.fail(
                  new SandboxError(
                    "copyOut",
                    `Failed to copy ${containerName}:${sandboxPath} -> ${hostPath}: ${error.message}`,
                  ),
                ),
              );
            } else {
              resume(Effect.succeed(undefined));
            }
          },
        );
      });
    }),
});

export const DockerSandbox = {
  layer: (containerName: string): Layer.Layer<Sandbox> =>
    Layer.succeed(Sandbox, makeDockerSandbox(containerName)),
};
