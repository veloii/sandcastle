import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecResult,
  Sandbox,
  SandboxError,
  type SandboxService,
} from "./Sandbox.js";

const execHost = (
  command: string,
  cwd: string,
): Effect.Effect<string, SandboxError> =>
  Effect.async<string, SandboxError>((resume) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new SandboxError(
                "execHost",
                `${command}: ${stderr?.toString() || error.message}`,
              ),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });

const execOk = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, SandboxError> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode !== 0
      ? Effect.fail(
          new SandboxError(
            "exec",
            `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          ),
        )
      : Effect.succeed(result),
  );

export const syncIn = (
  hostRepoDir: string,
  sandboxRepoDir: string,
): Effect.Effect<{ branch: string }, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // Get current branch from host
    const branch = (yield* execHost(
      "git rev-parse --abbrev-ref HEAD",
      hostRepoDir,
    )).trim();

    // Create git bundle on host
    const bundleDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-bundle-")),
    );
    const bundleHostPath = join(bundleDir, "repo.bundle");
    yield* execHost(`git bundle create "${bundleHostPath}" --all`, hostRepoDir);

    // Create temp dir in sandbox for the bundle
    const sandboxTmpDir = (yield* execOk(
      sandbox,
      "mktemp -d -t sandcastle-XXXXXX",
    )).stdout.trim();
    const bundleSandboxPath = `${sandboxTmpDir}/repo.bundle`;

    // Copy bundle into sandbox
    yield* sandbox.copyIn(bundleHostPath, bundleSandboxPath);

    // Check if sandbox repo already initialized
    const gitCheck = yield* sandbox.exec(
      `test -d "${sandboxRepoDir}/.git" && echo yes || echo no`,
    );
    const repoExists = gitCheck.stdout.trim() === "yes";

    if (repoExists) {
      // Fetch bundle into temp ref, reset to match host
      yield* execOk(
        sandbox,
        `git fetch "${bundleSandboxPath}" "${branch}:refs/sandcastle/sync" --force`,
        { cwd: sandboxRepoDir },
      );
      yield* execOk(sandbox, `git checkout -f "${branch}"`, {
        cwd: sandboxRepoDir,
      });
      yield* execOk(sandbox, "git reset --hard refs/sandcastle/sync", {
        cwd: sandboxRepoDir,
      });
      yield* execOk(sandbox, "git clean -fdx -e node_modules", {
        cwd: sandboxRepoDir,
      });
    } else {
      // Clone from bundle
      yield* execOk(
        sandbox,
        `git clone "${bundleSandboxPath}" "${sandboxRepoDir}"`,
      );
      yield* execOk(sandbox, `git checkout "${branch}"`, {
        cwd: sandboxRepoDir,
      });
    }

    // Clean up temp files
    yield* sandbox.exec(`rm -rf "${sandboxTmpDir}"`);
    yield* Effect.promise(() => rm(bundleDir, { recursive: true }));

    // Verify sync succeeded
    const hostHead = (yield* execHost(
      "git rev-parse HEAD",
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (hostHead !== sandboxHead) {
      yield* Effect.fail(
        new SandboxError(
          "syncIn",
          `HEAD mismatch after sync: host=${hostHead} sandbox=${sandboxHead}`,
        ),
      );
    }

    return { branch };
  });
