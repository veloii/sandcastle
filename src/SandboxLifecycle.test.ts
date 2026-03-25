import { Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type DisplayEntry, SilentDisplay } from "./Display.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { ExecError } from "./errors.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";

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

const testDisplayLayer = SilentDisplay.layer(
  Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
);

const setup = async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "host-"));
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-"));
  const sandboxRepoDir = join(sandboxDir, "repo");
  const layer = FilesystemSandbox.layer(sandboxDir);
  return { hostDir, sandboxDir, sandboxRepoDir, layer };
};

describe("withSandboxLifecycle", () => {
  it("full lifecycle — callback commit syncs back to host", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, (ctx) =>
        Effect.gen(function* () {
          // Configure git in sandbox
          yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
            cwd: ctx.sandboxRepoDir,
          });
          yield* ctx.sandbox.exec('git config user.name "Test"', {
            cwd: ctx.sandboxRepoDir,
          });

          // Create a commit in the sandbox
          yield* ctx.sandbox.exec(
            'sh -c "echo new-content > feature.txt && git add feature.txt && git commit -m \\"add feature\\""',
            { cwd: ctx.sandboxRepoDir },
          );
        }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Verify commit synced back to host
    const content = await readFile(join(hostDir, "feature.txt"), "utf-8");
    expect(content.trim()).toBe("new-content");

    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout).toContain("add feature");
  });

  it("onSandboxReady hooks run after sync-in", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir,
          hooks: {
            onSandboxReady: [{ command: "echo ready > ready-marker.txt" }],
          },
        },
        (ctx) =>
          Effect.gen(function* () {
            // Verify marker exists (created by hook running in sandboxRepoDir)
            const result = yield* ctx.sandbox.exec("cat ready-marker.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("ready");
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("baseHead is correct", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const hostHead = await getHead(hostDir);

    await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, (ctx) =>
        Effect.gen(function* () {
          expect(ctx.baseHead).toBe(hostHead);
        }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("callback return value passes through", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const result = await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, () =>
        Effect.succeed({ complete: true }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.result).toEqual({ complete: true });
  });

  it("no hooks is fine", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const result = await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, () =>
        Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.result).toBe("ok");
  });

  it("hook failure aborts before callback", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    let callbackRan = false;

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir,
            hooks: {
              onSandboxReady: [{ command: "exit 1" }],
            },
          },
          () =>
            Effect.sync(() => {
              callbackRan = true;
            }),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).rejects.toThrow();

    expect(callbackRan).toBe(false);
  });

  it("lifecycle works with a new branch that does not exist on host", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        { hostRepoDir: hostDir, sandboxRepoDir, branch: "feature/new" },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo new-content > feature.txt && git add feature.txt && git commit -m \\"add feature\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Branch should exist on host with the commit
    const { stdout: log } = await execAsync('git log --oneline "feature/new"', {
      cwd: hostDir,
    });
    expect(log).toContain("add feature");

    // Commits list should include the new commit
    expect(result.commits.length).toBe(1);
    expect(result.branch).toBe("feature/new");
  });

  it("no spinner for sync-out when work produces no commits", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, () =>
        Effect.succeed("no-op"),
      ).pipe(Effect.provide(Layer.merge(layer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const spinnerEntries = entries.filter((e) => e._tag === "spinner");
    expect(
      spinnerEntries.some((e) =>
        "message" in e ? e.message.includes("Syncing commits back") : false,
      ),
    ).toBe(false);
  });

  it("shows spinner for sync-out when work produces commits", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, (ctx) =>
        Effect.gen(function* () {
          yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
            cwd: ctx.sandboxRepoDir,
          });
          yield* ctx.sandbox.exec('git config user.name "Test"', {
            cwd: ctx.sandboxRepoDir,
          });
          yield* ctx.sandbox.exec(
            'sh -c "echo new > feature.txt && git add feature.txt && git commit -m \\"feat\\""',
            { cwd: ctx.sandboxRepoDir },
          );
        }),
      ).pipe(Effect.provide(Layer.merge(layer, displayLayer))),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const spinnerEntries = entries.filter((e) => e._tag === "spinner");
    expect(
      spinnerEntries.some((e) =>
        "message" in e ? e.message.includes("Syncing commits back") : false,
      ),
    ).toBe(true);
  });

  it("callback failure propagates (syncOut skipped)", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    await expect(
      Effect.runPromise(
        withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, () =>
          Effect.fail(
            new ExecError({ command: "test", message: "callback failed" }),
          ),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).rejects.toThrow("callback failed");

    // Host should be unchanged (no sync-out ran)
    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });
});

describe("withSandboxLifecycle (worktree mode — skipSync: true)", () => {
  const setupWorktree = async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await execAsync("git init -b main", { cwd: hostDir });
    await execAsync('git config user.email "test@test.com"', { cwd: hostDir });
    await execAsync('git config user.name "Test"', { cwd: hostDir });
    await writeFile(join(hostDir, "file.txt"), "original");
    await execAsync("git add file.txt", { cwd: hostDir });
    await execAsync('git commit -m "initial commit"', { cwd: hostDir });

    // Create a real git worktree from the host repo
    const worktreesDir = join(hostDir, ".sandcastle", "worktrees");
    await mkdir(worktreesDir, { recursive: true });
    const worktreeDir = join(worktreesDir, "test-worktree");
    await execAsync(
      `git worktree add -b "sandcastle/test" "${worktreeDir}" HEAD`,
      { cwd: hostDir },
    );

    const layer = FilesystemSandbox.layer(worktreeDir);
    return { hostDir, worktreeDir, layer };
  };

  it("skips sync-in — worktree files are already accessible", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          skipSync: true,
        },
        (ctx) =>
          Effect.gen(function* () {
            // Files from the host repo are already visible — no sync-in needed
            const result = yield* ctx.sandbox.exec("cat file.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("original");
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("commits in worktree are immediately visible on host (no sync-out needed)", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          skipSync: true,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo worktree-content > worktree-file.txt && git add worktree-file.txt && git commit -m \\"worktree commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Commit is visible on host under the worktree branch — no sync-out was needed
    const { stdout: log } = await execAsync(
      'git log --oneline "sandcastle/test"',
      { cwd: hostDir },
    );
    expect(log).toContain("worktree commit");

    // File is directly readable from the worktree (same filesystem)
    const content = await readFile(
      join(worktreeDir, "worktree-file.txt"),
      "utf-8",
    );
    expect(content.trim()).toBe("worktree-content");
  });

  it("onSandboxReady hooks still run in worktree mode", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          skipSync: true,
          hooks: {
            onSandboxReady: [{ command: "echo ready > ready-marker.txt" }],
          },
        },
        (ctx) =>
          Effect.gen(function* () {
            const result = yield* ctx.sandbox.exec("cat ready-marker.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("ready");
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("returns commits made in the worktree", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          skipSync: true,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo new > new-file.txt && git add new-file.txt && git commit -m \\"new commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.commits).toHaveLength(1);
    expect(result.branch).toBe("sandcastle/test");
  });

  it("returns empty commits when no work is done in worktree mode", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          skipSync: true,
        },
        () => Effect.succeed("no-op"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.commits).toHaveLength(0);
    expect(result.result).toBe("no-op");
  });
});
