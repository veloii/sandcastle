import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { SandcastleConfig } from "./Config.js";
import { Display } from "./Display.js";
import type { SandboxError } from "./errors.js";
import { Sandbox, type SandboxService } from "./Sandbox.js";
import { execOk, syncIn, syncOut } from "./SyncService.js";

const execAsync = promisify(exec);

export interface SandboxLifecycleOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly hooks?: SandcastleConfig["hooks"];
  readonly branch?: string;
  /** When true, skip sync-in and sync-out (worktree mode: repo is bind-mounted directly). */
  readonly skipSync?: boolean;
}

export interface SandboxContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly baseHead: string;
}

export interface SandboxLifecycleResult<A> {
  readonly result: A;
  readonly branch: string;
  readonly commits: { sha: string }[];
}

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  work: (
    ctx: SandboxContext,
  ) => Effect.Effect<A, SandboxError, Sandbox | Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Sandbox | Display> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, hooks, branch, skipSync } = options;

    // Setup: sync-in (isolated mode only), onSandboxReady hooks
    let resolvedBranch = "";
    yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        if (skipSync) {
          // Worktree mode: repo is bind-mounted — discover branch directly
          resolvedBranch = (yield* execOk(
            sandbox,
            "git rev-parse --abbrev-ref HEAD",
            { cwd: sandboxRepoDir },
          )).stdout.trim();
        } else {
          message("Syncing repo into sandbox");
          const syncResult = yield* syncIn(
            hostRepoDir,
            sandboxRepoDir,
            branch ? { branch } : undefined,
          );
          resolvedBranch = syncResult.branch;
        }

        if (hooks?.onSandboxReady?.length) {
          for (const hook of hooks.onSandboxReady) {
            message(hook.command);
            yield* execOk(sandbox, hook.command, { cwd: sandboxRepoDir });
          }
        }
      }),
    );

    const targetBranch = branch ?? resolvedBranch;

    // Record base HEAD
    const baseHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    // Record HEAD on the target branch before sync-out (isolated mode only)
    const headBeforeSyncOut = skipSync
      ? null
      : yield* Effect.promise(async () => {
          try {
            const { stdout } = await execAsync(
              `git rev-parse --verify "refs/heads/${targetBranch}"`,
              { cwd: hostRepoDir },
            );
            return stdout.trim();
          } catch {
            // Branch doesn't exist on host yet — will be created during sync-out
            return null;
          }
        });

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    if (!skipSync) {
      // Sync-out — only show spinner if there are commits to sync
      const currentHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
        cwd: sandboxRepoDir,
      })).stdout.trim();

      const syncOutEffect = syncOut(
        hostRepoDir,
        sandboxRepoDir,
        baseHead,
        branch ? { branch } : undefined,
      );

      if (currentHead !== baseHead) {
        yield* display.spinner("Syncing commits back to host", syncOutEffect);
      } else {
        yield* syncOutEffect;
      }
    }

    // Collect commits — in worktree mode they're already on host; in isolated mode
    // they were just applied by sync-out.
    const commits = yield* Effect.promise(async () => {
      // In isolated mode, use headBeforeSyncOut to capture only sync-out commits.
      // In worktree mode, use baseHead since commits land directly on the branch.
      const rangeStart = headBeforeSyncOut ?? baseHead;
      try {
        const { stdout } = await execAsync(
          `git rev-list "${rangeStart}..refs/heads/${targetBranch}" --reverse`,
          { cwd: hostRepoDir },
        );
        const lines = stdout.trim();
        if (!lines) return [];
        return lines.split("\n").map((sha) => ({ sha }));
      } catch {
        // Branch doesn't exist on host (no commits were produced)
        return [];
      }
    });

    return { result, branch: targetBranch, commits };
  });
